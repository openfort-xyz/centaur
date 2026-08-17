module GoogleChatSpacePermissionOwner
  extend ActiveSupport::Concern

  included do
    accepts_nested_attributes_for :google_chat_space_permissions
  end

  def google_chat_space_permissions_payload
    permissions = if association(:google_chat_space_permissions).loaded?
      google_chat_space_permissions.sort_by { |permission| [ permission.space_name, permission.id ] }
    else
      google_chat_space_permissions.ordered
    end
    permissions.map(&:as_permission_json)
  end
end
