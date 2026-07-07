require "test_helper"

class Console::IntegrationsControllerTest < ActionDispatch::IntegrationTest
  test "redirects to login when not signed in" do
    get console_integrations_url
    assert_redirected_to login_path
  end

  test "a non-admin sees enabled apps with their start links, logos, and no disabled apps" do
    post login_url, params: { email: users(:member_user).email, password: "password123456" }

    get console_integrations_url
    assert_response :ok

    # Enabled apps show up with their consent start links.
    %w[google slack github].each do |slug|
      assert_select "a[href=?]", "http://www.example.com/oauth/#{slug}/start"
    end
    # Disabled apps are hidden.
    assert_no_match "google-disabled", response.body

    # Known providers render a brand logo (inline SVG).
    assert_select "svg path[fill='#4285F4']" # Google
    assert_select "svg path[fill='#E01E5A']" # Slack
  end

  test "an admin sees the same page" do
    post login_url, params: { email: users(:acme_admin).email, password: "password123456" }

    get console_integrations_url
    assert_response :ok
    assert_select "a[href=?]", "http://www.example.com/oauth/google/start"
  end
end
