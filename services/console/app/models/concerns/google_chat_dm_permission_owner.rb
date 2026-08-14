module GoogleChatDmPermissionOwner
  extend ActiveSupport::Concern

  included do
    accepts_nested_attributes_for :google_chat_dm_permissions,
                                  allow_destroy: true,
                                  reject_if: :reject_google_chat_dm_permission_attributes?
  end

  def google_chat_dm_permissions_payload
    permissions = if association(:google_chat_dm_permissions).loaded?
      google_chat_dm_permissions.sort_by { |permission| [ permission.target_identity, permission.id ] }
    else
      google_chat_dm_permissions.ordered
    end
    permissions.map(&:as_permission_json)
  end

  private

  def reject_google_chat_dm_permission_attributes?(attributes)
    attributes["id"].blank? && attributes["target_identity"].blank?
  end
end
