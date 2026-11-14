require "test_helper"

module Api
  module V1
    class ConsoleScheduledTasksGoogleChatTest < ActionDispatch::IntegrationTest
      setup do
        @operator = users(:acme_admin)
        sign_in_console(@operator)
      end

      test "creates a task that delivers to the author's Google Chat DM" do
        post api_v1_console_scheduled_tasks_path,
             params: { data: task_params.merge(delivery_mode: "gchat_dm", delivery_channel: "C0123456789") },
             headers: csrf_headers, as: :json

        assert_response :created
        task = ScheduledTask.order(:id).last
        assert_equal @operator.email.downcase, task.delivery_channel
        assert_equal :gchat_dm, task.delivery_platform
        assert_equal "gchat_dm", json_body.dig("data", "delivery_mode")
        assert_equal "Google Chat DM to you", json_body.dig("data", "delivery_name")
      end

      test "creates a task that delivers to a granted Google Chat space" do
        grant_google_chat_space("spaces/AAQA42QLdws")

        GoogleChatSpaceDirectory.stub(:display_names, { "spaces/AAQA42QLdws" => "AI" }) do
          post api_v1_console_scheduled_tasks_path,
               params: { data: task_params.merge(delivery_mode: "gchat_space", delivery_channel: " Spaces/AAQA42QLdws ") },
               headers: csrf_headers, as: :json
        end

        assert_response :created
        assert_equal "spaces/AAQA42QLdws", ScheduledTask.order(:id).last.delivery_channel
        assert_equal "gchat_space", json_body.dig("data", "delivery_mode")
        assert_equal "AI", json_body.dig("data", "delivery_name")
      end

      test "rejects a Google Chat space the author cannot send to" do
        assert_no_difference -> { ScheduledTask.count } do
          post api_v1_console_scheduled_tasks_path,
               params: { data: task_params.merge(delivery_mode: "gchat_space", delivery_channel: "spaces/AAQAungranted") },
               headers: csrf_headers, as: :json
        end

        assert_response :unprocessable_entity
        assert_equal [ "is not available to the author" ], json_body.dig("error", "details", "delivery_channel")
      end

      test "new defaults to Google Chat DM delivery when Slack delivery is unavailable" do
        with_env("SLACK_BOT_TOKEN" => nil, "CENTAUR_CONSOLE_SLACK_BOT_TOKEN" => nil) do
          get new_api_v1_console_scheduled_task_path
        end

        assert_response :ok
        data = json_body["data"]
        assert_equal "gchat_dm", data["delivery_mode"]
        assert_equal false, data["slack_delivery_available"]
        assert_equal({ "direct_message_identity" => @operator.email.downcase, "spaces" => [] }, data["google_chat"])
      end

      test "form options list named send spaces and leave unnamed ones out" do
        principal = ConsoleUserPrincipalProvisioner.call(@operator)
        GoogleChatSpacePermission.replace_for!(
          principal,
          [ { space_name: "spaces/AAQA42QLdws", send_enabled: true },
            { space_name: "spaces/dmNoName1234", send_enabled: true },
            { space_name: "spaces/historyOnly1", history_enabled: true } ]
        )

        GoogleChatSpaceDirectory.stub(:display_names, { "spaces/AAQA42QLdws" => "AI" }) do
          get new_api_v1_console_scheduled_task_path
        end

        assert_equal [ { "name" => "spaces/AAQA42QLdws", "display_name" => "AI" } ],
                     json_body.dig("data", "google_chat", "spaces")
      end

      test "form options list every send space by resource name when names are unavailable" do
        grant_google_chat_space("spaces/AAQA42QLdws")

        GoogleChatSpaceDirectory.stub(:display_names, {}) do
          get new_api_v1_console_scheduled_task_path
        end

        assert_equal [ { "name" => "spaces/AAQA42QLdws", "display_name" => nil } ],
                     json_body.dig("data", "google_chat", "spaces")
      end

      test "edit describes a Google Chat space task with its form options" do
        grant_google_chat_space("spaces/AAQA42QLdws")
        task = create_task(delivery_channel: "spaces/AAQA42QLdws")

        GoogleChatSpaceDirectory.stub(:display_names, { "spaces/AAQA42QLdws" => "AI" }) do
          get edit_api_v1_console_scheduled_task_path(task.oid)
        end

        assert_response :ok
        data = json_body["data"]
        assert_equal "gchat_space", data["delivery_mode"]
        assert_equal "spaces/AAQA42QLdws", data["delivery_channel"]
        assert_equal "AI", data["delivery_name"]
        assert_equal [ "spaces/AAQA42QLdws" ], data.dig("google_chat", "spaces").map { |space| space["name"] }
      end

      test "the task list names Google Chat destinations" do
        grant_google_chat_space("spaces/AAQA42QLdws")
        create_task(name: "Space task", delivery_channel: "spaces/AAQA42QLdws")
        create_task(name: "DM task", delivery_channel: @operator.email.downcase)

        GoogleChatSpaceDirectory.stub(:display_names, { "spaces/AAQA42QLdws" => "AI" }) do
          get api_v1_console_scheduled_tasks_path
        end

        assert_response :ok
        names = json_body["data"].to_h { |task| [ task["name"], task["delivery_name"] ] }
        assert_equal({ "DM task" => "Google Chat DM to you", "Space task" => "AI" }, names)
      end

      private

      def grant_google_chat_space(space_name)
        GoogleChatSpacePermission.replace_for!(
          ConsoleUserPrincipalProvisioner.call(@operator),
          [ { space_name: space_name, send_enabled: true } ]
        )
      end

      def task_params
        {
          name: "Weekday incident summary",
          prompt: "Summarize open incidents.",
          schedule_preset: "weekdays",
          enabled: true
        }
      end

      def create_task(delivery_channel:, name: "Chat task")
        ScheduledTask.create!(name: name, prompt: "Summarize open incidents.", author: @operator,
                              delivery_channel: delivery_channel, cron_expression: "0 * * * *", enabled: true)
      end
    end
  end
end
