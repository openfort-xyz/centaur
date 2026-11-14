import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GoogleChatSpacePermissionRow } from "@/components/google-chat-permissions-editor";
import { apiResponse, mockApi, renderRoute } from "@/test/utils";

import type { Principal } from "./principals/api";
import { GoogleChatPermissionsSection } from "./principals/sections/GoogleChatPermissionsSection";
import type { Role } from "./roles/api";
import { RoleGoogleChatPermissionsSection } from "./roles/sections/RoleGoogleChatPermissionsSection";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function space(name: string, flags: Partial<GoogleChatSpacePermissionRow> = {}): GoogleChatSpacePermissionRow {
  return {
    space_name: name,
    send_enabled: false,
    update_enabled: false,
    delete_enabled: false,
    upload_enabled: false,
    download_enabled: false,
    history_enabled: false,
    members_enabled: false,
    reactions_enabled: false,
    ...flags,
  };
}

const principal = {
  id: "prn_1",
  google_chat_space_permissions: [space("spaces/OWN1", { send_enabled: true })],
  inherited_google_chat_space_permissions: [space("spaces/ROLE", { history_enabled: true })],
  google_chat_dm_permissions: [{ target_identity: "dm@example.com", setup_enabled: true }],
  inherited_google_chat_dm_permissions: [],
} as unknown as Principal;

const role = {
  id: "rol_1",
  google_chat_space_permissions: [space("spaces/AAAA", { send_enabled: true })],
  google_chat_dm_permissions: [],
} as unknown as Role;

function sectionFor(title: string): HTMLElement {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`no section for ${title}`);
  return section;
}
const spaceSection = () => sectionFor("Google Chat Space Permissions");
const dmSection = () => sectionFor("Google Chat DM Permissions");

describe("principal Google Chat permissions", () => {
  it("shows direct and inherited space rows", () => {
    mockApi({});
    renderRoute(<GoogleChatPermissionsSection principal={principal} />);

    expect(within(spaceSection()).getByLabelText("Send for spaces/OWN1")).toBeChecked();
    expect(within(spaceSection()).getByLabelText("History for spaces/ROLE (inherited)")).toBeDisabled();
    expect(within(dmSection()).getByText("dm@example.com")).toBeInTheDocument();
  });

  it("replaces the space set with edited flags plus the new space", async () => {
    const api = mockApi({ "PUT /api/v1/console/principals/prn_1/google_chat_space_permissions": { data: [] } });
    renderRoute(<GoogleChatPermissionsSection principal={principal} />);
    const section = within(spaceSection());

    await userEvent.click(section.getByLabelText("History for spaces/OWN1"));
    await userEvent.type(section.getByLabelText("Add Space"), "spaces/NEW1");
    await userEvent.click(section.getByLabelText("Delete for new Google Chat space"));
    await userEvent.click(section.getByRole("button", { name: "Save Google Chat space permissions" }));

    await waitFor(() => expect(api.calls("PUT /api/v1/console/principals/prn_1/google_chat_space_permissions")).toHaveLength(1));
    expect(api.calls("PUT /api/v1/console/principals/prn_1/google_chat_space_permissions")[0]?.body).toEqual({
      data: {
        google_chat_space_permissions: [
          space("spaces/OWN1", { send_enabled: true, history_enabled: true }),
          space("spaces/NEW1", {
            send_enabled: true,
            update_enabled: true,
            upload_enabled: true,
            download_enabled: true,
            history_enabled: true,
            members_enabled: true,
            reactions_enabled: true,
          }),
        ],
      },
    });
  });

  it("refuses a duplicate space and shows server validation errors", async () => {
    mockApi({
      "PUT /api/v1/console/principals/prn_1/google_chat_dm_permissions": apiResponse(422, {
        error: { message: "Target identity must be an email address" },
      }),
    });
    renderRoute(<GoogleChatPermissionsSection principal={principal} />);

    await userEvent.type(within(spaceSection()).getByLabelText("Add Space"), "Spaces/own1");
    await userEvent.click(within(spaceSection()).getByRole("button", { name: /Save/ }));
    expect(within(spaceSection()).getByRole("alert")).toHaveTextContent("Each Google Chat space can only be selected once.");

    await userEvent.type(within(dmSection()).getByLabelText("Add DM Target"), "not-an-email");
    await userEvent.click(within(dmSection()).getByRole("button", { name: /Save/ }));
    expect(await within(dmSection()).findByRole("alert")).toHaveTextContent("Target identity must be an email address");
  });

  it("deletes a DM target by email", async () => {
    const api = mockApi({ "DELETE /api/v1/console/principals/prn_1/google_chat_dm_permissions/dm%40example.com": undefined });
    renderRoute(<GoogleChatPermissionsSection principal={principal} />);

    await userEvent.click(within(dmSection()).getByRole("button", { name: "Delete dm@example.com" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.calls("DELETE /api/v1/console/principals/prn_1/google_chat_dm_permissions/dm%40example.com")).toHaveLength(1),
    );
  });
});

describe("role Google Chat permissions", () => {
  it("deletes a space through its spaces/<id> path", async () => {
    const api = mockApi({ "DELETE /api/v1/console/roles/rol_1/google_chat_space_permissions/spaces/AAAA": undefined });
    renderRoute(<RoleGoogleChatPermissionsSection role={role} />);

    expect(screen.queryByText("Inherited From Roles")).not.toBeInTheDocument();
    await userEvent.click(within(spaceSection()).getByRole("button", { name: "Delete spaces/AAAA" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.calls("DELETE /api/v1/console/roles/rol_1/google_chat_space_permissions/spaces/AAAA")).toHaveLength(1),
    );
  });

  it("adds a DM target", async () => {
    const api = mockApi({ "PUT /api/v1/console/roles/rol_1/google_chat_dm_permissions": { data: [] } });
    renderRoute(<RoleGoogleChatPermissionsSection role={role} />);

    await userEvent.type(within(dmSection()).getByLabelText("Add DM Target"), "person@example.com");
    await userEvent.click(within(dmSection()).getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(api.calls("PUT /api/v1/console/roles/rol_1/google_chat_dm_permissions")).toHaveLength(1));
    expect(api.calls("PUT /api/v1/console/roles/rol_1/google_chat_dm_permissions")[0]?.body).toEqual({
      data: { google_chat_dm_permissions: [{ target_identity: "person@example.com", setup_enabled: true }] },
    });
  });
});
