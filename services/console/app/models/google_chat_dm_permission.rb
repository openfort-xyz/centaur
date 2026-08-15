require "uri"

class GoogleChatDmPermission < ApplicationRecord
  include SyncConfigCacheInvalidation

  oid_prefix "gcdp"

  PERMISSION_ATTRIBUTES = %i[setup_enabled].freeze
  DEFAULT_ENABLED_ATTRIBUTES = { setup_enabled: true }.freeze
  attr_readonly :principal_id, :role_id, :target_identity

  belongs_to :principal, optional: true
  belongs_to :role, optional: true

  before_validation :normalize_target_identity

  validates :target_identity, presence: true
  validates :target_identity, uniqueness: { scope: :principal_id }, if: :principal_id?
  validates :target_identity, uniqueness: { scope: :role_id }, if: :role_id?
  validates :setup_enabled, inclusion: { in: [ true ] }
  validate :valid_target_identity
  validate :exactly_one_grantee

  scope :ordered, -> { order(:target_identity, :id) }

  def self.normalize_identity(value)
    value.to_s.strip.downcase
  end

  def self.permission_rows_payload(permission_rows)
    normalized_permission_rows(permission_rows).map do |attrs|
      { "target_identity" => attrs.fetch(:target_identity), "setup_enabled" => attrs.fetch(:setup_enabled) }
    end.sort_by { |row| row.fetch("target_identity") }
  end

  def self.replace_for!(grantee, permission_rows)
    association = grantee.google_chat_dm_permissions
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
    GoogleChatSpacePermission.principals_for_grantee(grantee)
  end

  def as_permission_json
    { "target_identity" => target_identity, "setup_enabled" => setup_enabled }
  end

  private

  def self.normalized_permission_rows(permission_rows)
    permission_rows.each_with_object({}) do |raw_attrs, rows|
      attrs = raw_attrs.to_h.symbolize_keys
      target_identity = normalize_identity(attrs[:target_identity])
      row = rows[target_identity] ||= { target_identity: target_identity, setup_enabled: false }
      row[:setup_enabled] ||= ActiveModel::Type::Boolean.new.cast(attrs[:setup_enabled]) == true
    end.values
  end
  private_class_method :normalized_permission_rows

  def self.bulk_insert_attributes(record, timestamp)
    record.attributes.slice(
      "principal_id", "role_id", "target_identity", "setup_enabled"
    ).merge("created_at" => timestamp, "updated_at" => timestamp)
  end
  private_class_method :bulk_insert_attributes

  def normalize_target_identity
    self.target_identity = self.class.normalize_identity(target_identity) if new_record?
  end

  def valid_target_identity
    return if !target_identity.start_with?("users/") && target_identity.match?(URI::MailTo::EMAIL_REGEXP)

    errors.add(:target_identity, "must be an email address")
  end

  def exactly_one_grantee
    return if [ principal, role ].compact.one?

    errors.add(:base, "must reference exactly one of principal, role")
  end

  def sync_config_affected_principals
    self.class.principals_for_grantee(principal || role)
  end
end
