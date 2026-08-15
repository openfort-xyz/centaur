class GoogleChatSpacePermission < ApplicationRecord
  include SyncConfigCacheInvalidation

  oid_prefix "gcsp"

  PERMISSION_FLAGS = [
    { attribute: :send_enabled, key: :send, claim: :send_spaces, label: "Send" },
    { attribute: :update_enabled, key: :update, claim: :update_spaces, label: "Update" },
    { attribute: :delete_enabled, key: :delete, claim: :delete_spaces, label: "Delete" },
    { attribute: :upload_enabled, key: :upload, claim: :upload_spaces, label: "Upload" },
    { attribute: :download_enabled, key: :download, claim: :download_spaces, label: "Download" },
    { attribute: :history_enabled, key: :history, claim: :history_spaces, label: "History" },
    { attribute: :members_enabled, key: :members, claim: :member_spaces, label: "Members" },
    { attribute: :reactions_enabled, key: :reactions, claim: :reaction_spaces, label: "Reactions" }
  ].freeze
  PERMISSION_ATTRIBUTES = PERMISSION_FLAGS.map { |flag| flag.fetch(:attribute) }.freeze
  PERMISSION_ATTRIBUTE_NAMES = PERMISSION_ATTRIBUTES.map(&:to_s).freeze
  DEFAULT_ENABLED_ATTRIBUTES = PERMISSION_ATTRIBUTES.to_h { |permission| [ permission, true ] }.freeze
  SPACE_NAME_FORMAT = %r{\Aspaces/[A-Za-z0-9_-]+\z}

  attr_readonly :principal_id, :role_id, :space_name

  belongs_to :principal, optional: true
  belongs_to :role, optional: true

  before_validation :normalize_space_name

  validates :space_name, presence: true,
                         format: { with: SPACE_NAME_FORMAT, message: "is not a valid Google Chat space name" }
  validates :space_name, uniqueness: { scope: :principal_id }, if: :principal_id?
  validates :space_name, uniqueness: { scope: :role_id }, if: :role_id?
  PERMISSION_ATTRIBUTES.each { |permission| validates permission, inclusion: { in: [ true, false ] } }
  validate :exactly_one_grantee
  validate :at_least_one_permission

  scope :ordered, -> { order(:space_name, :id) }

  def self.normalize_resource_name(value)
    value.to_s.strip.sub(%r{\Aspaces/}i, "spaces/")
  end

  def self.permission_rows_payload(permission_rows)
    normalized_permission_rows(permission_rows).map do |attrs|
      { "space_name" => attrs.fetch(:space_name) }.merge(
        PERMISSION_ATTRIBUTE_NAMES.to_h { |permission| [ permission, attrs.fetch(permission.to_sym) ] }
      )
    end.sort_by { |row| row.fetch("space_name") }
  end

  def self.replace_for!(grantee, permission_rows)
    association = grantee.google_chat_space_permissions
    rows = normalized_permission_rows(permission_rows)
    affected_principals = principals_for_grantee(grantee)

    transaction do
      association.delete_all
      association.reset
      records = rows.map { |attrs| association.build(attrs) }
      records.each { |record| raise ActiveRecord::RecordInvalid, record unless record.valid? }

      now = Time.current
      insert_all!(records.map { |record| bulk_insert_attributes(record, now) }) if records.any?
      Principal.bump_sync_config_cache_versions(affected_principals)
    end
  ensure
    grantee&.reset_google_chat_permissions_cache! if grantee.respond_to?(:reset_google_chat_permissions_cache!)
    association&.reset
  end

  def self.principals_for_grantee(grantee)
    case grantee
    when Principal then Principal.where(id: grantee.id)
    when Role then Principal.where(id: PrincipalRole.where(role_id: grantee.id).select(:principal_id))
    else Principal.none
    end
  end

  def as_permission_json
    { "space_name" => space_name }.merge(
      PERMISSION_ATTRIBUTE_NAMES.to_h { |permission| [ permission, public_send(permission) ] }
    )
  end

  private

  def self.normalized_permission_rows(permission_rows)
    permission_rows.each_with_object({}) do |raw_attrs, rows|
      attrs = raw_attrs.to_h.symbolize_keys
      space_name = normalize_resource_name(attrs[:space_name])
      row = rows[space_name] ||= { space_name: space_name }
      PERMISSION_ATTRIBUTES.each { |permission| row[permission] = false unless row.key?(permission) }
      PERMISSION_ATTRIBUTES.each do |permission|
        row[permission] ||= ActiveModel::Type::Boolean.new.cast(attrs[permission]) == true
      end
    end.values
  end
  private_class_method :normalized_permission_rows

  def self.bulk_insert_attributes(record, timestamp)
    record.attributes.slice(
      "principal_id", "role_id", "space_name", *PERMISSION_ATTRIBUTE_NAMES
    ).merge("created_at" => timestamp, "updated_at" => timestamp)
  end
  private_class_method :bulk_insert_attributes

  def normalize_space_name
    self.space_name = self.class.normalize_resource_name(space_name) if new_record?
  end

  def at_least_one_permission
    return if PERMISSION_ATTRIBUTES.any? { |permission| public_send(permission) }

    errors.add(:base, "Select at least one Google Chat space permission")
  end

  def exactly_one_grantee
    return if [ principal, role ].compact.one?

    errors.add(:base, "must reference exactly one of principal, role")
  end

  def sync_config_affected_principals
    self.class.principals_for_grantee(principal || role)
  end
end
