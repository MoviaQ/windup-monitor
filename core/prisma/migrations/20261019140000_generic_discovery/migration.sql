-- Generic service discovery (additive).
--
-- `monitorable` lets an agent state explicitly that a listener can be
-- checked even when its `kind` is unknown. `name_source` records only the
-- safe local rule that produced the display name (never cmdline/env).
-- Legacy agents omit both; existing rows keep the historical behaviour.
--
-- `services.transport` separates an HTTP check (legacy default) from a plain
-- TCP connect check. `last_restart_at` distinguishes an observed owner-process
-- restart from the first healthy observation after it.

CREATE TYPE "DiscoveryNameSource" AS ENUM (
  'exe',
  'comm',
  'package-json',
  'systemd',
  'container',
  'fallback',
  'fingerprint'
);

ALTER TABLE "discovered_services"
  ADD COLUMN "monitorable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "name_source" "DiscoveryNameSource";

ALTER TABLE "services"
  ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'http',
  ADD COLUMN "last_restart_at" TIMESTAMPTZ(6);

-- Generic discovery relaxes two hand-written CHECK constraints from the
-- services migration while keeping them tight for HTTP targets.
ALTER TABLE "discovered_services" DROP CONSTRAINT "discovered_services_kind_check";
ALTER TABLE "discovered_services"
  ADD CONSTRAINT "discovered_services_kind_check"
  CHECK ("kind" ~ '^[a-z0-9][a-z0-9-]{0,31}$');

ALTER TABLE "services" DROP CONSTRAINT "services_path_check";
ALTER TABLE "services"
  ADD CONSTRAINT "services_path_check"
  CHECK (
    ("transport" = 'tcp' AND "path" = '')
    OR ("path" LIKE '/%' AND "path" NOT LIKE '//%' AND length("path") <= 512)
  );

ALTER TABLE "services" DROP CONSTRAINT "services_expected_statuses_check";
ALTER TABLE "services"
  ADD CONSTRAINT "services_expected_statuses_check"
  CHECK (
    ("transport" = 'tcp' AND cardinality("expected_statuses") = 0)
    OR (cardinality("expected_statuses") >= 1 AND cardinality("expected_statuses") <= 10)
  );

ALTER TABLE "services"
  ADD CONSTRAINT "services_transport_check" CHECK ("transport" IN ('http', 'tcp'));
