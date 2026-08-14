export function MaterialSymbol({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`material-symbol${className ? ` ${className}` : ""}`}>
      {name}
    </span>
  );
}
