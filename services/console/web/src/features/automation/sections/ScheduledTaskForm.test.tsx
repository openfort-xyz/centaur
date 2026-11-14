import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockApi, renderRoute } from "@/test/utils";

import type { ScheduledTask } from "../api";
import { ScheduledTaskForm } from "./ScheduledTaskForm";

afterEach(() => {
  vi.unstubAllGlobals();
});

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: null,
    name: "Daily summary",
    prompt: "Summarize.",
    author_id: null,
    delivery_channel: null,
    delivery_mode: "gchat_dm",
    delivery_name: null,
    direct_message_user_id: null,
    cron_expression: "0 9 * * *",
    timezone: "America/Los_Angeles",
    schedule_preset: "daily",
    schedule_label: "Daily",
    custom_days: [],
    custom_time: "09:00",
    enabled: true,
    next_run_at: null,
    last_run_at: null,
    last_error: null,
    created_at: null,
    updated_at: null,
    slack_delivery_available: false,
    google_chat: {
      direct_message_identity: "me@example.com",
      spaces: [{ name: "spaces/AAQA42QLdws", display_name: "AI" }],
    },
    ...overrides,
  };
}

function renderForm(value: ScheduledTask) {
  mockApi({});
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  renderRoute(<ScheduledTaskForm task={value} submitLabel="Save task" onSubmit={onSubmit} />);
  return onSubmit;
}

describe("ScheduledTaskForm Google Chat delivery", () => {
  it("hides Slack when it is unavailable and submits the Google Chat DM", async () => {
    const onSubmit = renderForm(task());

    expect(screen.queryByRole("radio", { name: "Deliver to a channel" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Google Chat: my DM" })).toBeChecked();
    expect(screen.getByText("Your Google Chat DM goes to me@example.com.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save task" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ delivery_mode: "gchat_dm", delivery_channel: "" });
  });

  it("submits a typed space and suggests permitted spaces by name", async () => {
    const onSubmit = renderForm(task());

    await userEvent.click(screen.getByRole("radio", { name: "Google Chat: a space" }));
    expect(document.querySelector("datalist#google-chat-spaces option[value='spaces/AAQA42QLdws']")).toHaveTextContent("AI");
    await userEvent.type(screen.getByLabelText("Google Chat space"), " spaces/AAQA42QLdws ");
    await userEvent.click(screen.getByRole("button", { name: "Save task" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ delivery_mode: "gchat_space", delivery_channel: "spaces/AAQA42QLdws" });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("chat_space");
  });

  it("rejects a space that is not a spaces/<id> name", async () => {
    const onSubmit = renderForm(task());

    await userEvent.click(screen.getByRole("radio", { name: "Google Chat: a space" }));
    await userEvent.type(screen.getByLabelText("Google Chat space"), "AI team");
    await userEvent.click(screen.getByRole("button", { name: "Save task" }));

    expect(await screen.findByText("Enter a Google Chat space as spaces/<id>.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("edits a saved space task and keeps Slack options when Slack is available", () => {
    renderForm(
      task({
        id: "tsk_1",
        delivery_mode: "gchat_space",
        delivery_channel: "spaces/AAQA42QLdws",
        slack_delivery_available: true,
      }),
    );

    expect(screen.getByRole("radio", { name: "Deliver to a channel" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Google Chat: a space" })).toBeChecked();
    expect(screen.getByLabelText("Google Chat space")).toHaveValue("spaces/AAQA42QLdws");
  });
});
