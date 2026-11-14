import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  GOOGLE_CHAT_DM_KIND,
  GOOGLE_CHAT_SPACE_KIND,
  GoogleChatPermissionsEditor,
  type GoogleChatPermissionKey,
} from "@/components/google-chat-permissions-editor";
import { errorMessage } from "@/lib/api";

import { deletePrincipalGoogleChatPermission, replacePrincipalGoogleChatPermissions } from "../api";
import type { SectionProps } from "./types";

export function GoogleChatPermissionsSection({ principal }: SectionProps) {
  const queryClient = useQueryClient();
  const handlers = (key: GoogleChatPermissionKey) => ({
    onSave: async (rows: Parameters<typeof replacePrincipalGoogleChatPermissions>[3]) => {
      try {
        await replacePrincipalGoogleChatPermissions(queryClient, principal.id, key, rows);
        toast.success("Updated Google Chat permissions.");
      } catch (error) {
        throw new Error(errorMessage(error), { cause: error });
      }
    },
    onDelete: async (target: string) => {
      try {
        await deletePrincipalGoogleChatPermission(queryClient, principal.id, key, target);
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
        permissions={principal.google_chat_space_permissions}
        inherited={principal.inherited_google_chat_space_permissions}
        {...handlers(GOOGLE_CHAT_SPACE_KIND.key)}
      />
      <GoogleChatPermissionsEditor
        kind={GOOGLE_CHAT_DM_KIND}
        permissions={principal.google_chat_dm_permissions}
        inherited={principal.inherited_google_chat_dm_permissions}
        {...handlers(GOOGLE_CHAT_DM_KIND.key)}
      />
    </>
  );
}
