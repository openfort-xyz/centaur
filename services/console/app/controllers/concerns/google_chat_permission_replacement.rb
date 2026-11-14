# Console API editing of a principal's or role's Google Chat space and DM
# permissions as whole sets (the bearer API upserts one row at a time through
# GoogleChatPermissionApi). Include next to GoogleChatPermissionApi; the
# controller supplies google_chat_permission_owner.
module GoogleChatPermissionReplacement
  extend ActiveSupport::Concern

  # PUT /api/v1/console/{principals,roles}/:id/google_chat_space_permissions
  #
  # Replaces the owner's space permissions with data.google_chat_space_permissions.
  # An unchanged submission writes nothing (no sync-config bump).
  def replace_google_chat_space_permissions
    owner = google_chat_permission_owner
    rows = google_chat_space_permission_params.map(&:to_h)
    unless owner.google_chat_space_permissions_payload == GoogleChatSpacePermission.permission_rows_payload(rows)
      GoogleChatSpacePermission.replace_for!(owner, rows)
    end
    render json: { data: owner.reload.google_chat_space_permissions_payload }
  rescue ActiveRecord::RecordInvalid => e
    render_validation_error(e.record)
  end

  # DELETE /api/v1/console/{principals,roles}/:id/google_chat_space_permissions/spaces/:space_id
  def destroy_google_chat_space_permission
    space_name = GoogleChatSpacePermission.normalize_resource_name("spaces/#{params[:space_id]}")
    google_chat_permission_owner.google_chat_space_permissions.find_by!(space_name: space_name).destroy!
    head :no_content
  end

  # PUT /api/v1/console/{principals,roles}/:id/google_chat_dm_permissions
  #
  # Replaces the owner's DM permissions with data.google_chat_dm_permissions.
  def replace_google_chat_dm_permissions
    owner = google_chat_permission_owner
    rows = google_chat_dm_permission_params.map(&:to_h)
    unless owner.google_chat_dm_permissions_payload == GoogleChatDmPermission.permission_rows_payload(rows)
      GoogleChatDmPermission.replace_for!(owner, rows)
    end
    render json: { data: owner.reload.google_chat_dm_permissions_payload }
  rescue ActiveRecord::RecordInvalid => e
    render_validation_error(e.record)
  end

  # DELETE /api/v1/console/{principals,roles}/:id/google_chat_dm_permissions/:target_identity
  def destroy_google_chat_dm_permission
    target_identity = GoogleChatDmPermission.normalize_identity(params[:target_identity])
    google_chat_permission_owner.google_chat_dm_permissions.find_by!(target_identity: target_identity).destroy!
    head :no_content
  end
end
