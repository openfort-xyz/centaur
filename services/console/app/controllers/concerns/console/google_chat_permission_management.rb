module Console
  module GoogleChatPermissionManagement
    extend ActiveSupport::Concern

    private

    def load_google_chat_permission_forms(owner)
      @google_chat_space_permissions = owner.google_chat_space_permissions.ordered
      @google_chat_dm_permissions = owner.google_chat_dm_permissions.ordered
    end

    def update_google_chat_space_permissions_from_form(owner, path)
      rows = google_chat_permission_form_rows(
        owner,
        association: :google_chat_space_permissions,
        target: :space_name,
        flags: GoogleChatSpacePermission::PERMISSION_ATTRIBUTES
      )
      unless owner.google_chat_space_permissions_payload == GoogleChatSpacePermission.permission_rows_payload(rows)
        GoogleChatSpacePermission.replace_for!(owner, rows)
      end
      redirect_to path, notice: "Updated Google Chat space permissions."
    rescue ActiveRecord::RecordInvalid => e
      redirect_to path, alert: e.record.errors.full_messages.to_sentence
    rescue ActiveRecord::ReadonlyAttributeError
      redirect_to path, alert: "Google Chat spaces cannot be changed after creation."
    rescue ActiveRecord::RecordNotUnique
      redirect_to path, alert: "Each Google Chat space can only be selected once."
    end

    def update_google_chat_dm_permissions_from_form(owner, path)
      rows = google_chat_permission_form_rows(
        owner,
        association: :google_chat_dm_permissions,
        target: :target_identity,
        flags: GoogleChatDmPermission::PERMISSION_ATTRIBUTES
      )
      unless owner.google_chat_dm_permissions_payload == GoogleChatDmPermission.permission_rows_payload(rows)
        GoogleChatDmPermission.replace_for!(owner, rows)
      end
      redirect_to path, notice: "Updated Google Chat DM permissions."
    rescue ActiveRecord::RecordInvalid => e
      redirect_to path, alert: e.record.errors.full_messages.to_sentence
    rescue ActiveRecord::ReadonlyAttributeError
      redirect_to path, alert: "Google Chat DM targets cannot be changed after creation."
    rescue ActiveRecord::RecordNotUnique
      redirect_to path, alert: "Each Google Chat DM target can only be selected once."
    end

    def google_chat_permission_form_rows(owner, association:, target:, flags:)
      attributes_key = "#{association}_attributes"
      permitted = params.require(owner.model_name.param_key).permit(
        attributes_key => [ :id, target, *flags ]
      )
      rows = permitted.fetch(attributes_key, {}).values
      existing = owner.public_send(association).index_by { |permission| permission.id.to_s }

      rows.filter_map do |row|
        attrs = row.to_h.with_indifferent_access
        target_value = google_chat_target_for_form_row(attrs, existing, target)
        next if target_value.blank?

        { target => target_value }.merge(
          flags.to_h { |flag| [ flag, ActiveModel::Type::Boolean.new.cast(attrs[flag]) ] }
        )
      end
    end

    def google_chat_target_for_form_row(attrs, existing, target)
      return attrs[target] if attrs[:id].blank?

      permission = existing.fetch(attrs[:id].to_s) { raise ActiveRecord::RecordNotFound }
      submitted = attrs[target].to_s.strip
      current = permission.public_send(target)
      raise ActiveRecord::ReadonlyAttributeError if submitted.present? && submitted != current

      current
    end
  end
end
