"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

type Props = {
  id: string;
  manual: boolean;
  renamable: boolean;
  isCash: boolean;
  name: string;
  ownerLabel: string | null;
  cushion: string | null;
  includeInForecast: boolean;
};

/** Edit and Archive for one account. Only hand-entered accounts are archived here; accounts that only came from a bank keep the bank's name. */
export function AccountEditor(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      ownerLabel: String(data.get("ownerLabel") ?? ""),
      cushion: String(data.get("cushion") ?? ""),
    };
    if (props.renamable) body.name = String(data.get("name") ?? "");
    if (props.isCash) body.includeInForecast = data.get("includeInForecast") === "on";
    const result = await postJson(`/api/accounts/${props.id}/update`, body);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    setError(null);
    router.refresh();
  }

  async function archive() {
    if (!window.confirm(`Archive ${props.name}? Its balance history is kept.`)) return;
    const result = await postJson(`/api/accounts/${props.id}/archive`, {});
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)}>
          Edit
        </button>
        {props.manual && (
          <button type="button" onClick={archive}>
            Archive
          </button>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="form" onSubmit={save}>
      {props.renamable && (
        <label>
          Name
          <input name="name" defaultValue={props.name} required maxLength={80} />
        </label>
      )}
      <label>
        Owner
        <input name="ownerLabel" defaultValue={props.ownerLabel ?? ""} maxLength={40} />
      </label>
      <label>
        Cushion
        <input name="cushion" defaultValue={props.cushion ?? ""} inputMode="decimal" />
      </label>
      {props.isCash && (
        <label className="checkbox">
          <input type="checkbox" name="includeInForecast" defaultChecked={props.includeInForecast} /> Include in the forecast
        </label>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit">Save</button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
