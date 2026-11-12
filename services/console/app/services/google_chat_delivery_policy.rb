require "uri"

# Which Google Chat destinations a console user may deliver a scheduled task to.
#
# A space is allowed when the author's console principal holds an effective
# (direct or role) `send_spaces` grant for it; a DM is allowed only to one of
# the author's own addresses: their console email, or the verified email of
# their Google sign-in, which is the current one after a Workspace rename.
class GoogleChatDeliveryPolicy
  def initialize(user)
    @user = user
  end

  def allowed?(destination)
    destination = destination.to_s.strip
    return false if destination.blank?
    return user.google_addresses.include?(destination.downcase) if destination.match?(URI::MailTo::EMAIL_REGEXP)
    return false unless GoogleChatSpacePermission::SPACE_NAME_FORMAT.match?(destination)

    send_spaces.include?(GoogleChatSpacePermission.normalize_resource_name(destination))
  end

  def send_spaces
    @send_spaces ||= principal.google_chat_space_names_by_permission
                              .fetch(:send_spaces, [])
                              .uniq
                              .sort
  end

  # The address a DM to the author is sent to, which is the identity the bot
  # impersonates: the one their Google sign-in last reported, else their
  # console email.
  def direct_message_identity
    user.google_addresses.first.to_s
  end

  private

  attr_reader :user

  def principal
    @principal ||= ConsoleUserPrincipalProvisioner.call(user)
  end
end
