module Console
  class GoogleChatPermissionsController < ApplicationController
    layout "console"

    before_action :require_admin

    def destroy_space
      destroy_permission(GoogleChatSpacePermission, :google_chat_space_permission_id, "space")
    end

    def destroy_dm
      destroy_permission(GoogleChatDmPermission, :google_chat_dm_permission_id, "DM")
    end

    private

    def destroy_permission(model, param, label)
      permission = model.find_by_oid!(params.require(param))
      redirect_path = permission.principal ? console_principal_path(permission.principal.oid) : console_role_path(permission.role.oid)
      permission.destroy!
      redirect_to redirect_path, notice: "Deleted Google Chat #{label} permission."
    end
  end
end
