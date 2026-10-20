import { Icon } from "./Icon";

type BannerTone = "error" | "warn" | "info" | "offline";

export function Banner({
  tone,
  children,
  actions,
  role = "alert",
}: {
  tone: BannerTone;
  children: React.ReactNode;
  actions?: React.ReactNode;
  role?: "alert" | "status";
}): React.JSX.Element {
  const icon = tone === "error" ? "error" : tone === "warn" ? "warn" : tone === "offline" ? "offline" : "help";
  return (
    <div className={`banner banner--${tone}`} role={role}>
      <Icon name={icon} />
      <div>{children}</div>
      {actions ? <div className="banner-actions">{actions}</div> : null}
    </div>
  );
}
