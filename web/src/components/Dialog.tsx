import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

/**
 * Dostępny dialog modalny: focus na nagłówku przy otwarciu, Escape zamyka,
 * focus wraca do elementu otwierającego. Klawiatura i czytniki wg M3/a11y.
 */
export function Dialog({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (openerRef.current instanceof HTMLElement) {
        openerRef.current.focus();
      }
    };
  }, []);

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeRef.current();
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title" ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        <div>{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn btn--text" onClick={onClose}>
            <Icon name="close" /> Zamknij
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}
