module GoogleChatDmPermissionOwner
  extend ActiveSupport::Concern

  included do
    accepts_nested_attributes_for :google_chat_dm_permissions
  end

  def google_chat_dm_permissions_payload
    permissions = if association(:google_chat_dm_permissions).loaded?
      google_chat_dm_permissions.sort_by { |permission| [ permission.target_identity, permission.id ] }
    else
      google_chat_dm_permissions.ordered
    end
    permissions.map(&:as_permission_json)
  end
end
