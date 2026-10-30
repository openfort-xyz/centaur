# Lets a sandbox use selected admin API endpoints on behalf of a Console admin,
# but only from that admin's own DM with the bot. Two DM shapes qualify:
#
# - a Slack DM principal in the bot's own workspace (per the Slack channel
#   catalog) linked to an active admin;
# - a Google Chat DM space principal carrying the verified `google_email` that
#   api-rs stamps only on signature-verified 1:1 DMs, linked to the active admin
#   with that same email, whose current turn's verified requester (the
#   `gchat_user` principal bound to the proxy) is that same person.
#
# Channel, shared Google Chat space, Slack Connect, bare Google requester, and
# Console-user principals are refused; Console-user principals also run
# scheduled tasks and MCP sessions with no admin present. Slack-only operations
# (Slack principals, channel permissions, Slack Connect allowlist) additionally
# require the Slack DM shape via require_slack_admin_dm!. Include into a
# subclass of an Api::V1 admin controller.
module SandboxAdminAuthentication
  extend ActiveSupport::Concern
  include SandboxTokenAuthentication

  SLACK_DM_KIND = "slack_dm".freeze
  GCHAT_DM_KIND = "gchat_dm".freeze

  included do
    skip_before_action :authenticate_api_key!
    before_action :authenticate_sandbox_admin!
  end

  def current_user
    @sandbox_admin
  end

  private

  def authenticate_sandbox_admin!
    authenticate_sandbox_token!
    return if performed?

    principal = current_proxy.principal
    user = principal.console_user
    unless admin_dm_principal?(principal) && user&.active? && user.admin?
      return render_error(
        status: :forbidden,
        message: "admin changes require a Slack or Google Chat DM from an active Console admin"
      )
    end

    @sandbox_admin = user
    Rails.logger.info(
      "sandbox_admin_request admin=#{user.oid} principal=#{principal.oid} " \
      "proxy=#{current_proxy.oid} method=#{request.method} path=#{request.path}"
    )
  end

  def admin_dm_principal?(principal)
    case principal.kind
    when SLACK_DM_KIND then home_slack_team?(principal.slack_team_id)
    when GCHAT_DM_KIND then verified_google_dm?(principal)
    else false
    end
  end

  def home_slack_team?(team_id)
    team_id.present? && SlackBotChannel.exists?(team_id: team_id)
  end

  # The DM space's verified email must be the linked admin's email and the
  # email of the turn's verified requester, so a stale link, an operator-set
  # console_user_id, or an unverified turn never grants admin authority.
  def verified_google_dm?(principal)
    email = principal.google_chat_reader_subject
    return false if email.nil?

    requester = current_proxy.requester_principal
    return false unless requester&.kind == Principal::GCHAT_USER_KIND

    requester_email = requester.labels.to_h[Principal::GOOGLE_EMAIL_LABEL].to_s.strip.downcase
    email == requester_email && email == principal.console_user&.email
  end

  def slack_admin_dm?
    current_proxy.principal.kind == SLACK_DM_KIND
  end

  def require_slack_admin_dm!
    return if slack_admin_dm?

    render_error(
      status: :forbidden,
      message: "Slack principal, channel permission, and workspace changes require a Slack DM from an active Console admin"
    )
  end

  # Google Chat space and DM permissions are managed from a Google Chat DM, as
  # Slack channel permissions are from a Slack DM.
  def require_google_admin_dm!
    return if current_proxy.principal.kind == GCHAT_DM_KIND

    render_error(
      status: :forbidden,
      message: "Google Chat permission changes require a Google Chat DM from an active Console admin"
    )
  end
end
