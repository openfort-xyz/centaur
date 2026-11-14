import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  GOOGLE_CHAT_DM_KIND,
  GOOGLE_CHAT_SPACE_KIND,
  GoogleChatPermissionsEditor,
  type GoogleChatPermissionKey,
} from "@/components/google-chat-permissions-editor";
import { errorMessage } from "@/lib/api";

import { deleteRoleGoogleChatPermission, replaceRoleGoogleChatPermissions } from "../api";
import type { SectionProps } from "./types";

export function RoleGoogleChatPermissionsSection({ role }: SectionProps) {
  const queryClient = useQueryClient();
  const handlers = (key: GoogleChatPermissionKey) => ({
    onSave: async (rows: Parameters<typeof replaceRoleGoogleChatPermissions>[3]) => {
      try {
        await replaceRoleGoogleChatPermissions(queryClient, role.id, key, rows);
        toast.success("Updated Google Chat permissions.");
      } catch (error) {
        throw new Error(errorMessage(error), { cause: error });
      }
    },
    onDelete: async (target: string) => {
      try {
        await deleteRoleGoogleChatPermission(queryClient, role.id, key, target);
        toast.success("Deleted Google Chat permission.");
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
  });

  return (
    <>
      <GoogleChatPermissionsEditor
        kind={GOOGLE_CHAT_SPACE_KIND}
        permissions={role.google_chat_space_permissions}
        {...handlers(GOOGLE_CHAT_SPACE_KIND.key)}
      />
      <GoogleChatPermissionsEditor
        kind={GOOGLE_CHAT_DM_KIND}
        permissions={role.google_chat_dm_permissions}
        {...handlers(GOOGLE_CHAT_DM_KIND.key)}
      />
    </>
  );
}
