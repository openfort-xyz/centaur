require "uri"

# Which Google Chat destinations a console user may deliver a scheduled task to.
#
# A space is allowed when the author's console principal holds an effective
# (direct or role) `send_spaces` grant for it; a DM is allowed only to the
# author's own console email, which is the identity the bot impersonates.
class GoogleChatDeliveryPolicy
  def initialize(user)
    @user = user
  end

  def allowed?(destination)
    destination = destination.to_s.strip
    return false if destination.blank?
    return destination.downcase == direct_message_identity if destination.match?(URI::MailTo::EMAIL_REGEXP)
    return false unless GoogleChatSpacePermission::SPACE_NAME_FORMAT.match?(destination)

    send_spaces.include?(GoogleChatSpacePermission.normalize_resource_name(destination))
  end

  def send_spaces
    @send_spaces ||= principal.google_chat_space_names_by_permission
                              .fetch(:send_spaces, [])
                              .uniq
                              .sort
  end

  def direct_message_identity
    user.email.to_s.strip.downcase
  end

  private

  attr_reader :user

  def principal
    @principal ||= ConsoleUserPrincipalProvisioner.call(user)
  end
end
