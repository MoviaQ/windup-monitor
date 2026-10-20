// Background probe scheduler: a bounded worker pool plus a durable-aware
// result buffer.
//
// The metric heartbeat path (tick) must never block on probe execution: a
// full house of slow checks (64 checks x 4 workers x 10 s) would otherwise
// stall heartbeats past the offline threshold and mark a healthy host
// offline. Ticks therefore only SUBMIT due checks (non-blocking) and drain
// READY results (non-blocking); workers execute asynchronously.
//
// Durability rule: drained results are consumed from the buffer only after
// the envelope carrying them is durably persisted (seq + outbox write). A
// NextSeq/marshal/store failure keeps them buffered for the next tick, so
// no result is lost before it is durable and none is sent twice.
package agent

import (
	"context"
	"sync"
	"time"

	"windup-monitor/agent/internal/protocol"
)

const (
	// probeQueueLen bounds pending probe jobs (one queue slot per check at
	// most; MaxServiceChecks == probeQueueLen by construction).
	probeQueueLen = 64
	// maxBufferedResults bounds completed-but-undelivered results. Past the
	// cap the oldest are dropped (counted) so a long Core outage cannot grow
	// memory without bound; heartbeats keep flowing regardless.
	maxBufferedResults = 128
)

// probeJob is one asynchronous check execution with the candidate set as
// observed at submit time.
type probeJob struct {
	check protocol.ServiceCheck
	cands map[string]protocol.ServiceCandidate
	at    time.Time
}

// probePool runs at most workers jobs concurrently. Submit is non-blocking
// and reports whether the job was accepted. Stop cancels intake and joins
// in-flight jobs (each bounded by its probe timeout); handlers must finish
// without touching resources torn down by Stop.
type probePool struct {
	queue   chan probeJob
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	handler func(job probeJob)
}

func newProbePool(workers int, handler func(job probeJob)) *probePool {
	ctx, cancel := context.WithCancel(context.Background())
	p := &probePool{
		queue:   make(chan probeJob, probeQueueLen),
		ctx:     ctx,
		cancel:  cancel,
		handler: handler,
	}
	for i := 0; i < workers; i++ {
		p.wg.Add(1)
		go p.work()
	}
	return p
}

func (p *probePool) work() {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			return
		case job := <-p.queue:
			p.handler(job)
		}
	}
}

// submit enqueues a job without blocking; false means the pool is stopped
// or full (the tick retries the check later via its normal schedule).
func (p *probePool) submit(job probeJob) bool {
	select {
	case <-p.ctx.Done():
		return false
	default:
	}
	select {
	case p.queue <- job:
		return true
	default:
		return false
	}
}

// stop drains intake and waits for in-flight jobs. Bounded by probe
// timeouts; handlers run detached from the pool context so shutdown never
// aborts a measurement mid-flight (its result is simply dropped if the
// buffer is gone with the Runner).
func (p *probePool) stop() {
	p.cancel()
	p.wg.Wait()
}

type taggedResult struct {
	id  uint64
	res protocol.ServiceResult
}

// resultBuffer holds completed results until a tick durably persists them
// inside an envelope. peek/commit split the drain: peek copies ready
// results (dropping superseded revisions), commit discards exactly what was
// peeked — and only after SaveEnvelope succeeded.
type resultBuffer struct {
	mu      sync.Mutex
	items   []taggedResult
	next    uint64
	dropped uint64
}

func (b *resultBuffer) push(res protocol.ServiceResult) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.next++
	b.items = append(b.items, taggedResult{id: b.next, res: res})
	for len(b.items) > maxBufferedResults {
		b.items = b.items[1:]
		b.dropped++
	}
}

// peek copies up to max ready results at revision, dropping results from a
// superseded config revision. The returned mark feeds commit.
func (b *resultBuffer) peek(max int, revisions map[string]int) (out []protocol.ServiceResult, mark uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := make([]taggedResult, 0, len(b.items))
	for _, it := range b.items {
		if revision, exists := revisions[it.res.CheckID]; !exists || it.res.ConfigRevision != revision {
			continue
		}
		kept = append(kept, it)
		if len(out) < max {
			out = append(out, it.res)
			mark = it.id
		}
	}
	b.items = kept
	return out, mark
}

// commit discards everything peeked up to mark. Call only after the
// envelope carrying those results is durable on disk.
func (b *resultBuffer) commit(mark uint64) {
	if mark == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := make([]taggedResult, 0, len(b.items))
	for _, it := range b.items {
		if it.id > mark {
			kept = append(kept, it)
		}
	}
	b.items = kept
}

func (b *resultBuffer) len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.items)
}
