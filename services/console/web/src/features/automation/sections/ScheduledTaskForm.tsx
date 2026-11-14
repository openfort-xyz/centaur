import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";

import { ErrorAlert } from "@/components/alerts";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/form/fields";
import { applyApiErrors } from "@/components/form/form-errors";
import { SlackChannelPicker } from "@/components/slack-channel-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ApiError, errorMessage, humanize } from "@/lib/api";
import { cn } from "@/lib/utils";

import { deliveryChannelLoader, type ScheduledTask, type ScheduledTaskInput, type SchedulePreset } from "../api";

// ScheduledTask::SCHEDULE_PRESET_LABELS + Custom.
export const SCHEDULE_PRESET_OPTIONS: { value: SchedulePreset; label: string }[] = [
  { value: "manual", label: "Manual only" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "mondays", label: "Mondays" },
  { value: "fridays", label: "Fridays" },
  { value: "custom", label: "Custom" },
];

// ScheduledTask::CUSTOM_SCHEDULE_DAYS (cron weekday values, Sunday last).
export const CUSTOM_DAYS: [string, string][] = [
  ["Mon", "1"],
  ["Tue", "2"],
  ["Wed", "3"],
  ["Thu", "4"],
  ["Fri", "5"],
  ["Sat", "6"],
  ["Sun", "0"],
];

// A delivery destination typed by hand must be a channel (the DM is its own mode).
const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;
const CHAT_SPACE_PATTERN = /^spaces\/[A-Za-z0-9_-]+$/i;
const FIELDS = ["name", "prompt", "delivery_channel"] as const;

const schema = z
  .object({
    name: z.string().trim().min(1, "can't be blank").max(100, "is too long (maximum is 100 characters)"),
    prompt: z.string().trim().min(1, "can't be blank"),
    delivery_mode: z.enum(["dm", "channel", "gchat_dm", "gchat_space"]),
    delivery_channel: z.string(),
    chat_space: z.string(),
    schedule_preset: z.enum(["manual", "daily", "weekdays", "mondays", "fridays", "custom"]),
    custom_days: z.array(z.string()),
    custom_time: z.string(),
    enabled: z.boolean(),
  })
  // Rules the API would otherwise only report as a generic cron/channel error.
  .superRefine((values, ctx) => {
    if (values.delivery_mode === "channel" && values.delivery_channel.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["delivery_channel"], message: "Choose a Slack channel." });
    }
    if (values.delivery_mode === "gchat_space" && !CHAT_SPACE_PATTERN.test(values.chat_space.trim())) {
      ctx.addIssue({ code: "custom", path: ["chat_space"], message: "Enter a Google Chat space as spaces/<id>." });
    }
    if (values.schedule_preset === "custom") {
      if (values.custom_days.length === 0) {
        ctx.addIssue({ code: "custom", path: ["custom_days"], message: "Choose at least one day." });
      }
      if (values.custom_time === "") {
        ctx.addIssue({ code: "custom", path: ["custom_time"], message: "can't be blank" });
      }
    }
  });

type Values = z.infer<typeof schema>;

interface ScheduledTaskFormProps {
  task: ScheduledTask;
  submitLabel: string;
  onSubmit: (data: ScheduledTaskInput) => Promise<unknown>;
}

export function ScheduledTaskForm({ task, submitLabel, onSubmit }: ScheduledTaskFormProps) {
  const dmUserId = task.direct_message_user_id;
  const chatDm = task.google_chat?.direct_message_identity ?? "";
  const showSlack = task.slack_delivery_available !== false || task.delivery_mode === "dm" || task.delivery_mode === "channel";
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: task.name ?? "",
      prompt: task.prompt ?? "",
      delivery_mode: task.delivery_mode === "dm" && !dmUserId ? "channel" : task.delivery_mode,
      delivery_channel: task.delivery_mode === "channel" ? (task.delivery_channel ?? "") : "",
      chat_space: task.delivery_mode === "gchat_space" ? (task.delivery_channel ?? "") : "",
      schedule_preset: task.schedule_preset,
      custom_days: task.custom_days,
      custom_time: task.custom_time,
      enabled: task.enabled,
    },
  });
  const [channelValid, setChannelValid] = useState(true);
  const [saveError, setSaveError] = useState<unknown>(null);
  const deliveryMode = useWatch({ control: form.control, name: "delivery_mode" });
  const schedulePreset = useWatch({ control: form.control, name: "schedule_preset" });
  const loadOptions = deliveryChannelLoader(task.id);

  const submit = form.handleSubmit(async (values) => {
    setSaveError(null);
    try {
      const { chat_space: chatSpace, ...input } = values;
      await onSubmit({
        ...input,
        delivery_channel: deliveryChannel(values.delivery_mode, values.delivery_channel, chatSpace),
        custom_days: values.schedule_preset === "custom" ? values.custom_days : [],
      });
    } catch (error) {
      setSaveError(error);
      applyApiErrors(form.setError, error, FIELDS);
    }
  });

  const messages = saveErrorMessages(saveError);
  const cronError = saveError instanceof ApiError && (saveError.fieldErrors.cron_expression?.length ?? 0) > 0;
  const customTimeError = form.formState.errors.custom_time;

  return (
    <form onSubmit={submit} className="max-w-3xl space-y-6 rounded-xl border bg-card p-6 shadow-xs" noValidate>
      {messages.length > 0 && (
        <ErrorAlert className="mb-0">
          <p className="font-semibold">Could not save this task:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </ErrorAlert>
      )}

      <TextField
        control={form.control}
        name="name"
        label="Name"
        placeholder="Daily support summary"
        hint="A label for finding and managing this task in the console."
      />

      <TextareaField
        control={form.control}
        name="prompt"
        label="Agent prompt"
        rows={12}
        placeholder="Review open support issues and summarize the most important changes."
        hint="Each run sends this prompt through one agent turn."
      />

      <fieldset>
        <legend className="mb-3 block text-sm font-medium">Deliver to</legend>
        <Controller
          control={form.control}
          name="delivery_mode"
          render={({ field }) => (
            <RadioGroup
              name={field.name}
              value={field.value}
              onValueChange={(next) => field.onChange(next)}
              className="flex flex-wrap gap-x-6 gap-y-3"
            >
              {showSlack && (
                <>
                  <label className={cn("flex items-center gap-2 text-sm", dmUserId ? "cursor-pointer" : "cursor-not-allowed opacity-60")}>
                    <RadioGroupItem value="dm" disabled={!dmUserId} />
                    <span>Deliver to my DM</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <RadioGroupItem value="channel" />
                    <span>Deliver to a channel</span>
                  </label>
                </>
              )}
              <label className={cn("flex items-center gap-2 text-sm", chatDm ? "cursor-pointer" : "cursor-not-allowed opacity-60")}>
                <RadioGroupItem value="gchat_dm" disabled={!chatDm} />
                <span>Google Chat: my DM</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="gchat_space" />
                <span>Google Chat: a space</span>
              </label>
            </RadioGroup>
          )}
        />
        {deliveryMode === "channel" && (
          <div className="mt-3">
            <Controller
              control={form.control}
              name="delivery_channel"
              render={({ field, fieldState }) => (
                <>
                  <SlackChannelPicker
                    aria-label="Delivery channel"
                    loadOptions={loadOptions}
                    value={field.value}
                    selectedLabel={
                      task.delivery_mode === "channel" && field.value === task.delivery_channel ? task.delivery_name : null
                    }
                    onChange={field.onChange}
                    onValidityChange={setChannelValid}
                    pattern={CHANNEL_ID_PATTERN}
                  />
                  {fieldState.error && (
                    <p className="mt-1.5 text-xs text-destructive">{fieldState.error.message}</p>
                  )}
                </>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Public channels are always available. Private channels require both you and the Centaur bot to be members.
            </p>
          </div>
        )}
        {deliveryMode === "gchat_space" && (
          <div className="mt-3">
            <label htmlFor="scheduled-task-chat-space" className="mb-2 block text-sm font-medium">
              Google Chat space
            </label>
            <Controller
              control={form.control}
              name="chat_space"
              render={({ field, fieldState }) => (
                <>
                  <Input
                    id="scheduled-task-chat-space"
                    list="google-chat-spaces"
                    placeholder="spaces/AAQA42QLdws"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid || undefined}
                    {...field}
                  />
                  {fieldState.error && <p className="mt-1.5 text-xs text-destructive">{fieldState.error.message}</p>}
                </>
              )}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Spaces you can send to are suggested by name. Any space with a send permission is accepted.
            </p>
            <datalist id="google-chat-spaces">
              {task.google_chat?.spaces.map((space) => (
                <option key={space.name} value={space.name}>
                  {space.display_name ?? space.name}
                </option>
              ))}
            </datalist>
          </div>
        )}
        {deliveryMode === "gchat_dm" && (
          <p className="mt-2 text-xs text-muted-foreground">Your Google Chat DM goes to {chatDm}.</p>
        )}
        {showSlack && !dmUserId && (
          <p className="mt-2 text-xs text-muted-foreground">
            Connect your Slack account to deliver to your DM.
          </p>
        )}
      </fieldset>

      <div>
        <SelectField
          control={form.control}
          name="schedule_preset"
          label="Schedule"
          options={SCHEDULE_PRESET_OPTIONS}
          hint="Choose Manual only for an ad-hoc task, or run a preset at 9:00 AM Pacific Time."
        />

        {schedulePreset === "custom" && (
          <fieldset className="mt-4 rounded-lg border bg-muted/30 p-4">
            <legend className="px-1 text-sm font-semibold">Custom schedule</legend>
            <Controller
              control={form.control}
              name="custom_days"
              render={({ field, fieldState }) => (
                <div role="group" aria-labelledby="custom-days-label">
                  <span id="custom-days-label" className="mb-2 block text-sm font-medium">
                    Days
                  </span>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                    {CUSTOM_DAYS.map(([label, value]) => (
                      <label
                        key={value}
                        className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border bg-background px-2 py-2 text-sm transition-colors hover:bg-accent has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/10 dark:bg-input/30"
                      >
                        <Checkbox
                          value={value}
                          checked={field.value.includes(value)}
                          onCheckedChange={(checked) =>
                            field.onChange(
                              checked === true
                                ? [...field.value, value]
                                : field.value.filter((day) => day !== value),
                            )
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  {fieldState.error && (
                    <p className="mt-1.5 text-xs text-destructive">{fieldState.error.message}</p>
                  )}
                </div>
              )}
            />
            <div className="mt-4 max-w-xs">
              <label htmlFor="scheduled-task-custom-time" className="mb-2 block text-sm font-medium">
                Time
              </label>
              <Input
                id="scheduled-task-custom-time"
                type="time"
                required
                aria-invalid={customTimeError ? true : undefined}
                {...form.register("custom_time")}
              />
              {customTimeError && (
                <p className="mt-1.5 text-xs text-destructive">{customTimeError.message}</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">Custom schedules use Pacific Time.</p>
            </div>
          </fieldset>
        )}
        {cronError && (
          <p className="mt-2 text-xs text-destructive">Choose at least one day and a time.</p>
        )}
      </div>

      <div className="rounded-lg border bg-muted/30 px-4 py-3">
        <CheckboxField
          control={form.control}
          name="enabled"
          label="Task enabled"
          hint="Disabled tasks remain saved but cannot run."
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={form.formState.isSubmitting || (deliveryMode === "channel" && !channelValid)}
        >
          {submitLabel}
        </Button>
        <Button asChild variant="secondary">
          <Link to="/console/scheduled_tasks">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function deliveryChannel(mode: Values["delivery_mode"], slackChannel: string, chatSpace: string) {
  if (mode === "channel") return slackChannel;
  if (mode === "gchat_space") return chatSpace.trim();
  return "";
}

function saveErrorMessages(error: unknown): string[] {
  if (!error) return [];
  if (error instanceof ApiError && error.status === 422 && Object.keys(error.fieldErrors).length > 0) {
    return Object.entries(error.fieldErrors).flatMap(([key, list]) =>
      list.map((message) => (key === "base" ? message : `${humanize(key)} ${message}`)),
    );
  }
  return [errorMessage(error)];
}
