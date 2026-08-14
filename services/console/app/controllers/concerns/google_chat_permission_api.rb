module GoogleChatPermissionApi
  extend ActiveSupport::Concern

  InvalidGoogleChatPermissions = Class.new(StandardError)

  included do
    rescue_from InvalidGoogleChatPermissions, with: :render_google_chat_permissions_error
  end

  def upsert_google_chat_space_permission
    owner = google_chat_permission_owner
    attrs = upsert_google_chat_space_permission_params
    attrs[:space_name] = GoogleChatSpacePermission.normalize_resource_name(attrs[:space_name])
    permission, was_new = save_google_chat_permission!(
      owner.google_chat_space_permissions,
      attrs,
      target: :space_name,
      defaults: GoogleChatSpacePermission::DEFAULT_ENABLED_ATTRIBUTES
    )

    render status: (was_new ? :created : :ok), json: { data: permission.as_permission_json }
  rescue ActiveRecord::RecordInvalid => e
    render_validation_error(e.record)
  end

  def destroy_google_chat_space_permission
    owner = google_chat_permission_owner
    owner.google_chat_space_permissions.find_by_oid!(params.require(:permission_id)).destroy!
    head :no_content
  end

  def upsert_google_chat_dm_permission
    owner = google_chat_permission_owner
    attrs = upsert_google_chat_dm_permission_params
    attrs[:target_identity] = GoogleChatDmPermission.normalize_identity(attrs[:target_identity])
    permission, was_new = save_google_chat_permission!(
      owner.google_chat_dm_permissions,
      attrs,
      target: :target_identity,
      defaults: GoogleChatDmPermission::DEFAULT_ENABLED_ATTRIBUTES
    )

    render status: (was_new ? :created : :ok), json: { data: permission.as_permission_json }
  rescue ActiveRecord::RecordInvalid => e
    render_validation_error(e.record)
  end

  def destroy_google_chat_dm_permission
    owner = google_chat_permission_owner
    owner.google_chat_dm_permissions.find_by_oid!(params.require(:permission_id)).destroy!
    head :no_content
  end

  private

  def save_google_chat_permission!(association, attrs, target:, defaults:)
    permission = association.find_or_initialize_by(target => attrs[target])
    was_new = permission.new_record?
    permission.assign_attributes(defaults) if was_new
    permission.assign_attributes(was_new ? attrs : attrs.except(target))
    permission.save!
    [ permission, was_new ]
  rescue ActiveRecord::RecordNotUnique
    permission = association.find_by!(target => attrs[target])
    permission.update!(attrs.except(target))
    [ permission, false ]
  end

  def replace_google_chat_permissions!(owner)
    if data_params.key?(:google_chat_space_permissions)
      GoogleChatSpacePermission.replace_for!(owner, google_chat_space_permission_params)
    end
    if data_params.key?(:google_chat_dm_permissions)
      GoogleChatDmPermission.replace_for!(owner, google_chat_dm_permission_params)
    end
  end

  def google_chat_space_permission_params
    permission_array_params(
      :google_chat_space_permissions,
      [ :space_name, *GoogleChatSpacePermission::PERMISSION_ATTRIBUTES ]
    )
  end

  def google_chat_dm_permission_params
    permission_array_params(
      :google_chat_dm_permissions,
      [ :target_identity, :setup_enabled ]
    )
  end

  def permission_array_params(key, attributes)
    raw = data_params[key]
    raise InvalidGoogleChatPermissions, "#{key} must be an array" unless raw.nil? || raw.is_a?(Array)

    rows = data_params.permit(key => attributes).fetch(key, [])
    if raw.present? && rows.length != raw.length
      raise InvalidGoogleChatPermissions, "#{key} rows must be objects"
    end

    rows
  end

  def upsert_google_chat_space_permission_params
    data_params.permit(:space_name, *GoogleChatSpacePermission::PERMISSION_ATTRIBUTES)
  end

  def upsert_google_chat_dm_permission_params
    data_params.permit(:target_identity, :setup_enabled)
  end

  def render_google_chat_permissions_error(error)
    render_error(status: :unprocessable_entity, message: error.message)
  end
end
