export function Badge({ status }: { status: string }) {
  const normalized = status.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return <span className={`badge badge-${normalized}`}>{status.replaceAll("_", " ")}</span>;
}
