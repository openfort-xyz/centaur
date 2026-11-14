import { Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { SectionHeading } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const headClass = "h-10 px-5 text-xs font-medium text-muted-foreground";

type SpaceFlag =
  | "send_enabled"
  | "update_enabled"
  | "delete_enabled"
  | "upload_enabled"
  | "download_enabled"
  | "history_enabled"
  | "members_enabled"
  | "reactions_enabled";

export type GoogleChatSpacePermissionRow = { space_name: string } & Record<SpaceFlag, boolean>;
export interface GoogleChatDmPermissionRow {
  target_identity: string;
  setup_enabled: boolean;
}

export type GoogleChatPermissionKey = "google_chat_space_permissions" | "google_chat_dm_permissions";

interface PermissionKind<K extends string, F extends string> {
  key: GoogleChatPermissionKey;
  title: string;
  noun: string;
  targetKey: K;
  targetLabel: string;
  addLabel: string;
  placeholder: string;
  empty: string;
  flags: { attribute: F; label: string }[];
}

/** GoogleChatSpacePermission::PERMISSION_FLAGS */
export const GOOGLE_CHAT_SPACE_KIND: PermissionKind<"space_name", SpaceFlag> = {
  key: "google_chat_space_permissions",
  title: "Google Chat Space Permissions",
  noun: "Google Chat space",
  targetKey: "space_name",
  targetLabel: "Space",
  addLabel: "Add Space",
  placeholder: "spaces/AAAA",
  empty: "No Google Chat spaces selected.",
  flags: [
    { attribute: "send_enabled", label: "Send" },
    { attribute: "update_enabled", label: "Update" },
    { attribute: "delete_enabled", label: "Delete" },
    { attribute: "upload_enabled", label: "Upload" },
    { attribute: "download_enabled", label: "Download" },
    { attribute: "history_enabled", label: "History" },
    { attribute: "members_enabled", label: "Members" },
    { attribute: "reactions_enabled", label: "Reactions" },
  ],
};

export const GOOGLE_CHAT_DM_KIND: PermissionKind<"target_identity", "setup_enabled"> = {
  key: "google_chat_dm_permissions",
  title: "Google Chat DM Permissions",
  noun: "Google Chat DM target",
  targetKey: "target_identity",
  targetLabel: "Target email",
  addLabel: "Add DM Target",
  placeholder: "person@example.com",
  empty: "No Google Chat DM targets selected.",
  flags: [{ attribute: "setup_enabled", label: "Setup" }],
};

type Row<K extends string, F extends string> = Record<K, string> & Record<F, boolean>;

export interface GoogleChatPermissionsEditorProps<K extends string, F extends string> {
  kind: PermissionKind<K, F>;
  permissions: Row<K, F>[];
  /** Read-only permissions inherited from roles (principals only). */
  inherited?: Row<K, F>[];
  /** Persist the full replacement set. Resolve on success; throw to keep the draft. */
  onSave: (rows: Row<K, F>[]) => Promise<unknown>;
  onDelete: (target: string) => Promise<unknown>;
}

export function GoogleChatPermissionsEditor<K extends string, F extends string>({
  kind,
  permissions,
  inherited = [],
  onSave,
  onDelete,
}: GoogleChatPermissionsEditorProps<K, F>) {
  const allOn = () => Object.fromEntries(kind.flags.map((flag) => [flag.attribute, true])) as Record<F, boolean>;
  const inputId = useId();
  const [draft, setDraft] = useState(permissions);
  const [newTarget, setNewTarget] = useState("");
  const [newFlags, setNewFlags] = useState(allOn);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [source, setSource] = useState(permissions);
  if (source !== permissions) {
    setSource(permissions);
    setDraft(permissions);
  }

  const target = (row: Record<K, string>): string => row[kind.targetKey];

  const setFlag = (rowTarget: string, flag: F, value: boolean) =>
    setDraft((rows) => rows.map((row) => (target(row) === rowTarget ? { ...row, [flag]: value } : row)));

  const save = async () => {
    setError(null);
    const rows = [...draft];
    const typed = newTarget.trim();
    if (typed) {
      if (permissions.some((row) => target(row).toLowerCase() === typed.toLowerCase())) {
        setError(`Each ${kind.noun} can only be selected once.`);
        return;
      }
      rows.push({ [kind.targetKey]: typed, ...newFlags } as Row<K, F>);
    }
    setSaving(true);
    try {
      await onSave(rows);
      setNewTarget("");
      setNewFlags(allOn());
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not save ${kind.noun} permissions.`);
    } finally {
      setSaving(false);
    }
  };

  const header = (withDelete: boolean) => (
    <TableHeader className="bg-muted/40">
      <TableRow className="hover:bg-transparent">
        <TableHead scope="col" className={headClass}>
          {kind.targetLabel}
        </TableHead>
        {kind.flags.map((flag) => (
          <TableHead key={flag.attribute} scope="col" className={headClass}>
            {flag.label}
          </TableHead>
        ))}
        {withDelete && (
          <TableHead scope="col" className={headClass}>
            Remove
          </TableHead>
        )}
      </TableRow>
    </TableHeader>
  );

  return (
    <section className="mb-8">
      <div className="mb-3">
        <SectionHeading>{kind.title}</SectionHeading>
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {draft.length > 0 ? (
          <Table>
            {header(true)}
            <TableBody>
              {draft.map((row) => (
                <TableRow key={target(row)}>
                  <TableCell className="min-w-56 break-all px-5 py-3 text-sm font-medium">{target(row)}</TableCell>
                  {kind.flags.map((flag) => (
                    <TableCell key={flag.attribute} className="px-5 py-3">
                      <Checkbox
                        aria-label={`${flag.label} for ${target(row)}`}
                        checked={row[flag.attribute]}
                        onCheckedChange={(checked) => setFlag(target(row), flag.attribute, checked === true)}
                      />
                    </TableCell>
                  ))}
                  <TableCell className="px-5 py-3">
                    <ConfirmDialog
                      title={`Delete ${target(row)}?`}
                      description={`The owner loses these permissions for this ${kind.noun}.`}
                      confirmLabel="Delete"
                      onConfirm={() => onDelete(target(row))}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          title={`Delete ${target(row)}`}
                          aria-label={`Delete ${target(row)}`}
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState className="py-6">{kind.empty}</EmptyState>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-t p-5">
          <div className="min-w-56 flex-1">
            <Label className="mb-2 block" htmlFor={inputId}>
              {kind.addLabel}
            </Label>
            <Input
              id={inputId}
              value={newTarget}
              placeholder={kind.placeholder}
              autoComplete="off"
              onChange={(event) => setNewTarget(event.target.value)}
            />
          </div>
          {kind.flags.map((flag) => (
            <label key={flag.attribute} className="flex h-9 cursor-pointer items-center gap-2">
              <Checkbox
                checked={newFlags[flag.attribute]}
                aria-label={`${flag.label} for new ${kind.noun}`}
                onCheckedChange={(checked) => setNewFlags((flags) => ({ ...flags, [flag.attribute]: checked === true }))}
              />
              <span className="text-sm font-medium">{flag.label}</span>
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="px-5 pb-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="px-5 pb-5">
          <Button type="button" disabled={saving} onClick={() => void save()}>
            Save {kind.noun} permissions
          </Button>
        </div>
      </Card>

      {inherited.length > 0 && (
        <>
          <div className="mt-6 mb-3">
            <h3 className="text-sm font-semibold">Inherited From Roles</h3>
          </div>
          <Card className="gap-0 overflow-hidden py-0">
            <Table>
              {header(false)}
              <TableBody>
                {inherited.map((row) => (
                  <TableRow key={target(row)}>
                    <TableCell className="break-all px-5 py-3 text-sm font-medium">{target(row)}</TableCell>
                    {kind.flags.map((flag) => (
                      <TableCell key={flag.attribute} className="px-5 py-3">
                        <Checkbox
                          checked={row[flag.attribute]}
                          disabled
                          aria-label={`${flag.label} for ${target(row)} (inherited)`}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </section>
  );
}
