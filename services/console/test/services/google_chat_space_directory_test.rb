require "test_helper"

class GoogleChatSpaceDirectoryTest < ActiveSupport::TestCase
  class FakeClient
    def initialize(response)
      @response = response
    end

    def list_google_chat_spaces
      @response.is_a?(Exception) ? raise(@response) : @response
    end
  end

  setup do
    @user = users(:acme_admin)
  end

  test "maps granted spaces to display names and skips unnamed spaces" do
    client = FakeClient.new(
      "spaces" => [
        { "name" => "spaces/AAQA42QLdws", "displayName" => "AI" },
        { "name" => "spaces/lw57hyAAAAE", "spaceType" => "DIRECT_MESSAGE" },
        { "displayName" => "orphan" }
      ]
    )

    assert_equal(
      { "spaces/AAQA42QLdws" => "AI" },
      GoogleChatSpaceDirectory.display_names(@user, client: client)
    )
  end

  test "returns an empty map when the proxy is unreachable" do
    client = FakeClient.new(CentaurApiClient::Error.new("boom", status: 502))

    assert_equal({}, GoogleChatSpaceDirectory.display_names(@user, client: client))
  end
end
