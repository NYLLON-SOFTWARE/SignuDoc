export type FolderOption = { id: string; name: string };

export function FolderSelect({
  allowUnfiled,
  disabled,
  folders,
  onChange,
  value,
}: {
  allowUnfiled?: boolean;
  disabled?: boolean;
  folders: readonly FolderOption[];
  onChange: (id: string) => void;
  value: string;
}) {
  return (
    <label className="grid max-w-xl gap-1.5">
      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
        Folder
      </span>
      <select
        className="field-input"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        required={!allowUnfiled}
        value={value}
      >
        <option disabled={!allowUnfiled} value="">
          {allowUnfiled ? "Unfiled" : "Choose a folder"}
        </option>
        {folders.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
