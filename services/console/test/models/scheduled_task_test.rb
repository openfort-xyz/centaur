require "test_helper"

class ScheduledTaskTest < ActiveSupport::TestCase
  setup do
    user = users(:acme_admin)
    user.user_identities.create!(
      provider: "slack",
      subject: "U0123456789",
      team_id: "T0123456789"
    )
  end

  test "maps schedule presets to cron and calculates the next run in Pacific Time" do
    travel_to Time.utc(2026, 8, 19, 12) do
      task = ScheduledTask.create!(
        valid_attributes(
          cron_expression: ScheduledTask.cron_for("daily", nil)
        )
      )

      assert_equal "0 9 * * *", task.cron_expression
      assert_equal ScheduledTask::DEFAULT_TIMEZONE, task.timezone
      assert_equal Time.utc(2026, 8, 19, 16), task.next_run_at
      assert_equal "daily", task.schedule_preset
      assert_equal "Daily at 9:00 PT", task.schedule_label
    end
  end

  test "allows a task without a recurring schedule" do
    task = ScheduledTask.create!(valid_attributes(cron_expression: nil))

    assert_nil task.cron_expression
    assert_nil task.next_run_at
    assert_equal "manual", task.schedule_preset
    assert_equal "Manual only", task.schedule_label
    assert_nil ScheduledTask.cron_for("manual")
  end

  test "maps the requested weekday presets to cron schedules" do
    assert_equal "0 9 * * 1-5", ScheduledTask.cron_for("weekdays")
    assert_equal "0 9 * * 1", ScheduledTask.cron_for("mondays")
    assert_equal "0 9 * * 5", ScheduledTask.cron_for("fridays")
  end

  test "builds a custom cron schedule from selected days and time" do
    cron = ScheduledTask.cron_for(
      "custom",
      custom_days: %w[5 1 3 9],
      custom_time: "14:30"
    )
    task = ScheduledTask.new(valid_attributes(cron_expression: cron))

    assert_equal "30 14 * * 1,3,5", cron
    assert_equal "custom", task.schedule_preset
    assert_equal %w[1 3 5], task.custom_schedule_days
    assert_equal "14:30", task.custom_schedule_time
    assert_equal "Mon, Wed, Fri at 2:30 PM PT", task.schedule_label
  end

  test "rejects incomplete custom schedules" do
    assert_empty ScheduledTask.cron_for("custom", custom_days: [], custom_time: "09:00")
    assert_empty ScheduledTask.cron_for("custom", custom_days: %w[1], custom_time: "25:00")
  end

  test "uses the cron expression as the schedule label when it cannot be edited as a weekly schedule" do
    task = ScheduledTask.new(valid_attributes(cron_expression: "0 * * * *"))

    assert_equal "0 * * * *", task.schedule_label
  end

  test "validates custom cron schedules and Slack delivery channels" do
    task = ScheduledTask.new(
      valid_attributes(cron_expression: "not cron", delivery_channel: "general")
    )

    assert_not task.valid?
    assert_includes task.errors[:cron_expression], "is not a valid five-field cron schedule"
    assert_includes task.errors[:delivery_channel], "must be a Slack channel or user ID"
  end

  test "allows the author's direct message and rejects an unavailable channel" do
    direct_message_task = ScheduledTask.new(valid_attributes(delivery_channel: "U0123456789"))
    unavailable_task = ScheduledTask.new(valid_attributes(delivery_channel: "C9999999999"))

    assert direct_message_task.valid?
    assert_not unavailable_task.valid?
    assert_includes unavailable_task.errors[:delivery_channel], "is not available to the author"
  end

  test "disabling a task clears its next run" do
    task = ScheduledTask.create!(valid_attributes)

    task.update!(enabled: false)

    assert_nil task.next_run_at
  end

  test "accepts standard five-field cron" do
    [
      "0 18 * * 0", "30 16 * * 1-5", "*/15 * * * *", "0 * * * *", "0 9 * * 7", "0 9 * * MON-FRI",
      "0 9 1 jan *", "0 9-17/4 * * *", "5,35 * * * *", "0 9 1-15/2 * 1,3", "0 9 * * 1-5/2"
    ].each do |cron|
      assert ScheduledTask.new(valid_attributes(cron_expression: cron)).valid?, cron
    end
  end

  # api-rs computes next runs for standard cron only
  # (crates/centaur-console-db/src/cron.rs), so fugit's extensions are refused.
  test "rejects cron fugit accepts but api-rs does not run" do
    [
      "@daily", "0 0 9 * * *", "0 9 L * *", "0 9 -1 * *", "0 9 * * 1#2", "0 9 * * mon%2",
      "0 9 * * 1&", "0 9~11 * * *", "0 24 * * *", "0 9 * * 5-1", "5/15 9 * * *", "*/0 9 * * *",
      "0 9 *,1 * *", "0 9 1, * *", "0 9 30 2 *"
    ].each do |cron|
      task = ScheduledTask.new(valid_attributes(cron_expression: cron))

      assert_not task.valid?, cron
      assert_includes task.errors[:cron_expression], "is not a valid five-field cron schedule", cron
    end
  end

  test "requires an IANA timezone" do
    assert ScheduledTask.new(valid_attributes(timezone: "Europe/Berlin")).valid?

    [ "+05:00", "PST", "Pacific Time (US & Canada)" ].each do |timezone|
      task = ScheduledTask.new(valid_attributes(timezone: timezone))

      assert_not task.valid?, timezone
      assert_includes task.errors[:timezone], "must be an IANA timezone name"
    end
  end

  test "saving a user's task provisions the Console principal it runs as" do
    author = users(:acme_admin)
    foreign_id = ConsoleUserPrincipalProvisioner.new(author).send(:foreign_id)
    Principal.where(foreign_id: foreign_id).destroy_all

    task = ScheduledTask.create!(valid_attributes)

    principal = Principal.find_by!(foreign_id: foreign_id)
    assert_equal "console_user", principal.kind
    assert_equal author, principal.console_user
    assert_equal principal, task.execution_principal
  end

  test "a channel task runs as its channel without provisioning a user principal" do
    channel = principals(:acme_channel)

    assert_no_difference -> { Principal.where(kind: "console_user").count } do
      task = ScheduledTask.create!(name: "Channel digest", prompt: "Summarize this channel.", principal: channel)

      assert_equal channel, task.execution_principal
    end
  end

  test "allows a granted Google Chat space and rejects an ungranted one" do
    grant_google_chat_space("spaces/AAQA42QLdws")
    granted = ScheduledTask.new(valid_attributes(delivery_channel: "spaces/AAQA42QLdws"))
    ungranted = ScheduledTask.new(valid_attributes(delivery_channel: "spaces/AAQAotherspace"))

    assert granted.valid?
    assert_equal :gchat_space, granted.delivery_platform
    assert_not ungranted.valid?
    assert_includes ungranted.errors[:delivery_channel], "is not available to the author"
  end

  test "allows the author's own Google Chat DM email and rejects anyone else's" do
    own_dm = ScheduledTask.new(valid_attributes(delivery_channel: users(:acme_admin).email))
    foreign_dm = ScheduledTask.new(valid_attributes(delivery_channel: users(:globex_admin).email))

    assert own_dm.valid?
    assert_equal :gchat_dm, own_dm.delivery_platform
    assert_not foreign_dm.valid?
    assert_includes foreign_dm.errors[:delivery_channel], "is not available to the author"
  end

  test "a Google Chat DM task keeps running and follows the author to a new address" do
    task = ScheduledTask.create!(valid_attributes(delivery_channel: "admin@acme.example"))
    user_identities(:acme_admin_google).update!(email: "admin@renamed.example")
    task.reload

    assert task.valid?, task.errors.full_messages.to_sentence
    assert_equal "admin@renamed.example", GoogleChatDeliveryPolicy.new(users(:acme_admin)).direct_message_identity
    assert_equal "admin@acme.example", task.delivery_channel
    moved = ScheduledTask.new(valid_attributes(name: "Moved", delivery_channel: "admin@renamed.example"))
    assert moved.valid?, moved.errors.full_messages.to_sentence
  end

  test "an unverified Google sign-in email is not a DM destination" do
    user_identities(:acme_admin_google).update!(email: "admin@renamed.example", email_verified: false)

    assert_not ScheduledTask.new(valid_attributes(delivery_channel: "admin@renamed.example")).valid?
    assert_equal "admin@acme.example", GoogleChatDeliveryPolicy.new(users(:acme_admin)).direct_message_identity
  end

  private

  def grant_google_chat_space(space_name, user: users(:acme_admin))
    principal = ConsoleUserPrincipalProvisioner.call(user)
    GoogleChatSpacePermission.replace_for!(
      principal,
      [ { space_name: space_name, send_enabled: true } ]
    )
    principal
  end

  def valid_attributes(overrides = {})
    {
      name: "Incident summary",
      prompt: "Summarize open incidents.",
      author: users(:acme_admin),
      delivery_channel: "C0123456789",
      cron_expression: "0 * * * *",
      enabled: true
    }.merge(overrides)
  end
end
