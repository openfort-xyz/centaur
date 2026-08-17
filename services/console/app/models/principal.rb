require "uri"

class Principal < ApplicationRecord
  oid_prefix "prn"

  include ForeignIdCollisionGuard
  attr_readonly :foreign_id

  has_many :grants, dependent: :destroy
  # Proxies outlive their principal: deleting a principal unassigns its proxies
  # rather than destroying them, leaving them ready for reassignment.
  has_many :proxies, dependent: :nullify
  has_many :requester_proxies, class_name: "Proxy", foreign_key: :requester_principal_id, dependent: :nullify
  has_many :principal_roles, dependent: :destroy
  has_many :roles, through: :principal_roles
  has_many :slack_channel_permissions, dependent: :destroy
  has_many :google_chat_space_permissions, dependent: :destroy
  has_many :google_chat_dm_permissions, dependent: :destroy
  has_many :sync_config_snapshots, class_name: "PrincipalSyncConfigSnapshot", dependent: :destroy
  has_many :mcp_oauth_authorization_codes, dependent: :destroy
  has_many :mcp_oauth_refresh_tokens, dependent: :destroy
  belongs_to :created_by, class_name: "User"
  belongs_to :console_user, class_name: "User", optional: true

  include SlackChannelPermissionOwner
  include GoogleChatSpacePermissionOwner
  include GoogleChatDmPermissionOwner

  after_commit :auto_grant_matching_oauth_credentials, on: %i[create update]
  after_create :assign_default_roles, if: :roles_blank_for_defaulting?
  before_validation :apply_sandbox_repo_cache_label
  before_commit :bump_own_sync_config_cache_version, on: :update, if: :sync_config_fields_changed?

  URL_SAFE_FORMAT = /\A[A-Za-z0-9\-._~]+\z/
  URL_SAFE_MESSAGE = "must contain only URL-safe characters (A-Z, a-z, 0-9, -, ., _, ~)"
  SANDBOX_REPO_CACHE_LABEL = "centaur.sandbox_repo_cache".freeze
  SANDBOX_REPO_CACHE_VALUES = %w[none public all].freeze
  UNKNOWN_KIND = "unknown".freeze
  KINDS = %w[
    unknown user console_user workflow slack_channel slack_dm discord_channel linear_issue
    teams_user teams_conversation gchat_dm gchat_space
  ].freeze
  SLACK_USER_ID_FORMAT = /\A(?:[UW][A-Z0-9]{8,}|USLACK)\z/
  SLACK_CHANNEL_ID_FORMAT = /\A[CDG][A-Z0-9]{8,}\z/
  SLACK_TEAM_ID_FORMAT = /\A[TE][A-Z0-9]{8,}\z/

  validates :foreign_id, uniqueness: { allow_nil: true },
            format: { with: URL_SAFE_FORMAT, message: URL_SAFE_MESSAGE }, allow_nil: true
  validates :sandbox_repo_cache, inclusion: { in: SANDBOX_REPO_CACHE_VALUES }
  validates :kind, presence: true,
                   inclusion: { in: KINDS, message: "must be one of #{KINDS.join(", ")}" }
  validates :slack_user_id, format: { with: SLACK_USER_ID_FORMAT, message: "is not a valid Slack user ID" },
                            allow_nil: true, if: :will_save_change_to_slack_user_id?
  validates :slack_channel_id, format: { with: SLACK_CHANNEL_ID_FORMAT, message: "is not a valid Slack channel ID" },
                               allow_nil: true, if: :will_save_change_to_slack_channel_id?
  validates :slack_team_id, format: { with: SLACK_TEAM_ID_FORMAT, message: "is not a valid Slack scope ID" },
                            allow_nil: true, if: :will_save_change_to_slack_team_id?
  validates :slack_email, format: { with: URI::MailTo::EMAIL_REGEXP, message: "is not a valid email address" },
                          allow_nil: true, if: :will_save_change_to_slack_email?
  validates :console_user_email, format: { with: URI::MailTo::EMAIL_REGEXP, message: "is not a valid email address" },
                                 allow_nil: true, if: :will_save_change_to_console_user_email?

  # Stand-in for an inline secret value in redacted config: operator inspection
  # reports that a control_plane source carries a value without revealing it.
  REDACTED = "[redacted]".freeze
  SLACK_CHANNEL_ID_LABEL = "slack_channel_id".freeze

  # The config of a principal with no effective grants; also what an unassigned
  # proxy resolves to.
  EMPTY_CONFIG = { "secrets" => [], "transforms" => [], "postgres" => [] }.freeze

  # Every grant this principal resolves to: its own direct grants plus the
  # grants of every role it is assigned. Secrets reachable through more than one
  # path collapse naturally because callers select distinct secret rows.
  def effective_grants
    Grant.where(principal_id: id).or(Grant.where(role_id: role_ids))
  end

  # Static secrets this principal resolves to, via its effective grants.
  def granted_static_secrets
    granted_secrets_by_priority(StaticSecret, :static_secret_id, includes: %i[source rules])
  end

  # Static wrapper secrets this principal may carry into turns it starts as
  # the requester: DIRECT grants only (never role grants, so shared role
  # infrastructure cannot hoist), and only wrappers of broker credentials
  # whose OAuth app an admin marked always_available. Starting from
  # StaticSecret structurally excludes every other secret kind.
  def always_available_static_secrets
    priorities = grants
      .where.not(static_secret_id: nil)
      .group(:static_secret_id)
      .select("static_secret_id AS secret_id, MAX(priority) AS effective_priority")

    StaticSecret
      .joins("INNER JOIN (#{priorities.to_sql}) granted_priorities " \
             "ON granted_priorities.secret_id = static_secrets.id")
      .joins(broker_credential: :oauth_app)
      .where(oauth_apps: { always_available: true })
      .select("static_secrets.*", "granted_priorities.effective_priority")
      .includes(:source, :rules)
      .order(Arel.sql("granted_priorities.effective_priority ASC, static_secrets.id ASC"))
  end

  # gcp_auth credentials this principal resolves to, via its effective grants.
  def granted_gcp_auth_secrets
    granted_secrets_by_priority(GcpAuthSecret, :gcp_auth_secret_id, includes: %i[keyfile_source rules])
  end

  # gcp_id_token credentials this principal resolves to, via its effective grants.
  def granted_gcp_id_token_secrets
    granted_secrets_by_priority(GcpIdTokenSecret, :gcp_id_token_secret_id, includes: %i[keyfile_source rules])
  end

  # aws_auth credentials this principal resolves to, via its effective grants.
  def granted_aws_auth_secrets
    granted_secrets_by_priority(AwsAuthSecret, :aws_auth_secret_id, includes: %i[sources rules])
  end

  # oauth_token credentials this principal resolves to, via its effective grants.
  def granted_oauth_token_secrets
    granted_secrets_by_priority(OauthTokenSecret, :oauth_token_secret_id, includes: %i[sources rules])
  end

  # hmac_sign credentials this principal resolves to, via its effective grants.
  def granted_hmac_secrets
    granted_secrets_by_priority(HmacSecret, :hmac_secret_id, includes: %i[sources rules])
  end

  # Postgres upstreams this principal resolves to, via its effective grants.
  def granted_pg_dsn_secrets
    granted_secrets_by_priority(PgDsnSecret, :pg_dsn_secret_id, includes: %i[dsn_source])
  end

  def apply_default_sandbox_capabilities!(supplied = {})
    return unless new_record?

    defaults = SystemSetting.current.principal_defaults
    unless supplied_key?(supplied, :sandbox_repo_cache)
      self.sandbox_repo_cache = defaults[:sandbox_repo_cache]
    end
    unless supplied_key?(supplied, :sandbox_observability_enabled)
      self.sandbox_observability_enabled = defaults[:sandbox_observability_enabled]
    end
    unless supplied_key?(supplied, :sandbox_api_server_enabled)
      self.sandbox_api_server_enabled = defaults[:sandbox_api_server_enabled]
    end
  end

  def labels_with_sandbox_capabilities
    labels.to_h.merge(
      SANDBOX_REPO_CACHE_LABEL => sandbox_repo_cache
    )
  end

  def effective_slack_channel_permissions_payload
    @effective_slack_channel_permissions_payload ||= merged_slack_channel_permissions(effective_slack_channel_permissions)
  end

  def inherited_slack_channel_permissions_payload
    @inherited_slack_channel_permissions_payload ||= begin
      permissions = if loaded_role_slack_channel_permissions?
        roles.flat_map { |role| role.slack_channel_permissions.to_a }
      else
        SlackChannelPermission.where(role_id: role_ids)
      end
      merged_slack_channel_permissions(permissions)
    end
  end

  def slack_history_channel_ids
    slack_channel_ids_by_permission.fetch(:history)
  end

  def slack_jwt_channel_ids
    slack_channel_ids_by_permission.values.flatten.uniq
  end

  def slack_channel_ids_by_permission
    @slack_channel_ids_by_permission ||= begin
      initial = SlackChannelPermission::PERMISSION_FLAGS.to_h { |flag| [ flag.fetch(:key), [] ] }
      effective_slack_channel_permissions_payload.each_with_object(initial) do |row, channels|
        channel_id = row.fetch("channel_id")
        SlackChannelPermission::PERMISSION_FLAGS.each do |flag|
          channels[flag.fetch(:key)] << channel_id if row.fetch(flag.fetch(:attribute).to_s)
        end
      end
    end
  end

  def reset_slack_channel_permissions_cache!
    %i[
      @effective_slack_channel_permissions_payload
      @inherited_slack_channel_permissions_payload
      @slack_channel_ids_by_permission
    ].each do |ivar|
      remove_instance_variable(ivar) if instance_variable_defined?(ivar)
    end
  end

  def effective_google_chat_space_permissions_payload
    @effective_google_chat_space_permissions_payload ||=
      merged_google_chat_space_permissions(effective_google_chat_space_permissions)
  end

  def inherited_google_chat_space_permissions_payload
    @inherited_google_chat_space_permissions_payload ||= begin
      permissions = if loaded_role_google_chat_permissions?(:google_chat_space_permissions)
        roles.flat_map { |role| role.google_chat_space_permissions.to_a }
      else
        GoogleChatSpacePermission.where(role_id: role_ids)
      end
      merged_google_chat_space_permissions(permissions)
    end
  end

  def effective_google_chat_dm_permissions_payload
    @effective_google_chat_dm_permissions_payload ||=
      merged_google_chat_dm_permissions(effective_google_chat_dm_permissions)
  end

  def inherited_google_chat_dm_permissions_payload
    @inherited_google_chat_dm_permissions_payload ||= begin
      permissions = if loaded_role_google_chat_permissions?(:google_chat_dm_permissions)
        roles.flat_map { |role| role.google_chat_dm_permissions.to_a }
      else
        GoogleChatDmPermission.where(role_id: role_ids)
      end
      merged_google_chat_dm_permissions(permissions)
    end
  end

  def google_chat_space_names_by_permission
    @google_chat_space_names_by_permission ||= begin
      initial = GoogleChatSpacePermission::PERMISSION_FLAGS.to_h { |flag| [ flag.fetch(:claim), [] ] }
      effective_google_chat_space_permissions_payload.each_with_object(initial) do |row, spaces|
        GoogleChatSpacePermission::PERMISSION_FLAGS.each do |flag|
          spaces[flag.fetch(:claim)] << row.fetch("space_name") if row.fetch(flag.fetch(:attribute).to_s)
        end
      end
    end
  end

  def google_chat_dm_setup_targets
    effective_google_chat_dm_permissions_payload.filter_map do |row|
      row.fetch("target_identity") if row.fetch("setup_enabled")
    end.sort
  end

  def google_chat_reader_subject
    email = labels&.fetch("google_email", nil) if kind == "gchat_dm"
    email = email.to_s.strip.downcase
    email if email.match?(URI::MailTo::EMAIL_REGEXP)
  end

  def google_chat_reader_subjects_by_space
    spaces_by_id = google_chat_space_names_by_permission.values.flatten.uniq.to_h do |space|
      [ space.delete_prefix("spaces/"), space ]
    end
    return {} if spaces_by_id.empty?

    subjects = Hash.new { |hash, space| hash[space] = [] }
    Principal.where("labels ->> 'gchat_space_id' IN (?)", spaces_by_id.keys)
      .find_each do |space_principal|
        space = spaces_by_id[space_principal.labels["gchat_space_id"]]
        subject = space_principal.google_chat_reader_subject
        subjects[space] << subject if space && subject
      end
    configured = labels["google_chat_reader_subjects"]
    if configured.is_a?(Hash)
      configured.each do |space, email|
        email = email.to_s.strip.downcase
        subjects[space] << email if spaces_by_id.value?(space) && email.match?(URI::MailTo::EMAIL_REGEXP)
      end
    end
    subjects.filter_map do |space, emails|
      unique = emails.uniq
      [ space, unique.first ] if unique.one?
    end.to_h
  end

  def google_chat_jwt_targets
    google_chat_space_names_by_permission.values.flatten.concat(google_chat_dm_setup_targets).uniq
  end

  def reset_google_chat_permissions_cache!
    %i[
      @effective_google_chat_space_permissions_payload
      @inherited_google_chat_space_permissions_payload
      @effective_google_chat_dm_permissions_payload
      @inherited_google_chat_dm_permissions_payload
      @google_chat_space_names_by_permission
      @google_chat_dm_setup_targets
    ].each do |ivar|
      remove_instance_variable(ivar) if instance_variable_defined?(ivar)
    end
  end

  def self.bump_sync_config_cache_versions(targets)
    scope = sync_config_cache_bump_scope(targets)
    return unless scope

    scope.update_all("sync_config_cache_version = sync_config_cache_version + 1")
  end

  def self.enqueue_sync_config_snapshot_warm(ids)
    Array(ids).compact.uniq.each do |id|
      PrincipalSyncConfigSnapshotWarmJob.perform_later(id)
    end
  end

  def self.effective_grantees_for_grantable(grantable)
    association = grantable.model_name.singular.to_sym
    grants = Grant.where(association => grantable)
    direct = where(id: grants.where.not(principal_id: nil).select(:principal_id))
    role_members = where(
      id: PrincipalRole.where(
        role_id: grants.where.not(role_id: nil).select(:role_id)
      ).select(:principal_id)
    )
    direct.or(role_members)
  end

  def self.combine_scopes(scopes)
    scopes.compact.reduce(none) { |combined, scope| combined.or(scope) }
  end

  # Deep-walk a config payload and blank out the inline value of every
  # control_plane source, leaving the rest of the structure intact.
  def self.redact_live_secrets(value)
    case value
    when Hash
      redacted = value.transform_values { |v| redact_live_secrets(v) }
      redacted["value"] = REDACTED if redacted["type"] == "control_plane" && redacted.key?("value")
      redacted
    when Array
      value.map { |v| redact_live_secrets(v) }
    else
      value
    end
  end

  private

  def roles_blank_for_defaulting?
    association(:roles).target.empty? && !roles.exists?
  end

  def assign_default_roles
    role_ids = Role.where(assign_by_default: true).ids
    return if role_ids.empty?

    # These assignments are part of the principal's initial state, so there is
    # no prior sync config to invalidate.
    PrincipalRole.insert_all!(role_ids.map { |role_id| { principal_id: id, role_id: role_id } })
  end

  def auto_grant_matching_oauth_credentials
    PrincipalCredentialReconciliation.new.apply_for_principal(self)
  end

  def apply_sandbox_repo_cache_label
    self[:labels] = labels.to_h.merge(SANDBOX_REPO_CACHE_LABEL => sandbox_repo_cache)
  end

  def supplied_key?(attributes, key)
    attributes.key?(key) || attributes.key?(key.to_s)
  end

  def effective_slack_channel_permissions
    return slack_channel_permissions.to_a unless persisted?

    if association(:slack_channel_permissions).loaded? && loaded_role_slack_channel_permissions?
      return slack_channel_permissions.to_a + roles.flat_map { |role| role.slack_channel_permissions.to_a }
    end

    direct = SlackChannelPermission.where(principal_id: id)
    role_permissions = SlackChannelPermission.where(role_id: role_ids)
    direct.or(role_permissions)
  end

  def loaded_role_slack_channel_permissions?
    association(:roles).loaded? &&
      roles.all? { |role| role.association(:slack_channel_permissions).loaded? }
  end

  def effective_google_chat_space_permissions
    effective_google_chat_permissions_for(:google_chat_space_permissions, GoogleChatSpacePermission)
  end

  def effective_google_chat_dm_permissions
    effective_google_chat_permissions_for(:google_chat_dm_permissions, GoogleChatDmPermission)
  end

  def effective_google_chat_permissions_for(association_name, model)
    association_rows = public_send(association_name)
    return association_rows.to_a unless persisted?

    if association(association_name).loaded? && loaded_role_google_chat_permissions?(association_name)
      return association_rows.to_a + roles.flat_map { |role| role.public_send(association_name).to_a }
    end

    model.where(principal_id: id).or(model.where(role_id: role_ids))
  end

  def loaded_role_google_chat_permissions?(association_name)
    association(:roles).loaded? && roles.all? { |role| role.association(association_name).loaded? }
  end

  def merged_google_chat_space_permissions(permissions)
    merged_permission_rows(
      permissions,
      target_attribute: :space_name,
      permission_attributes: GoogleChatSpacePermission::PERMISSION_ATTRIBUTE_NAMES
    )
  end

  def merged_google_chat_dm_permissions(permissions)
    merged_permission_rows(
      permissions,
      target_attribute: :target_identity,
      permission_attributes: %w[setup_enabled]
    )
  end

  def merged_permission_rows(permissions, target_attribute:, permission_attributes:)
    ordered = permissions.sort_by do |permission|
      [ permission.principal_id.present? ? 0 : 1, permission.role_id || 0, permission.id || 0 ]
    end

    ordered.each_with_object({}) do |permission, rows|
      target = permission.public_send(target_attribute)
      row = rows[target] ||= { target_attribute.to_s => target }
      permission_attributes.each { |flag| row[flag] = false unless row.key?(flag) }
      permission_attributes.each { |flag| row[flag] ||= permission.public_send(flag) }
    end.values.sort_by { |row| row.fetch(target_attribute.to_s) }
  end

  def merged_slack_channel_permissions(permissions)
    ordered = permissions.sort_by do |permission|
      [ permission.principal_id.present? ? 0 : 1, permission.role_id || 0, permission.id || 0 ]
    end

    ordered.each_with_object({}) do |permission, by_channel|
      channel_id = permission.channel_id.to_s.strip.upcase
      row = by_channel[channel_id] ||= {
        "channel_id" => channel_id
      }
      SlackChannelPermission::PERMISSION_ATTRIBUTE_NAMES.each { |flag| row[flag] = false unless row.key?(flag) }
      SlackChannelPermission::PERMISSION_ATTRIBUTE_NAMES.each do |flag|
        row[flag] ||= permission.public_send(flag)
      end
    end.values.sort_by { |row| row.fetch("channel_id") }
  end

  def self.host_from_url(value)
    URI.parse(value.to_s).host
  rescue URI::InvalidURIError
    nil
  end

  # Canonical form for hosts used in iron-proxy injection rules, so rule
  # matching never hinges on case, whitespace, or a trailing dot.
  def self.normalize_hosts(hosts)
    Array(hosts)
      .map { |host| host.to_s.strip.downcase.delete_suffix(".") }
      .reject(&:blank?)
      .uniq
  end

  def self.sync_config_cache_bump_scope(targets)
    case targets
    when ActiveRecord::Relation
      targets
    else
      ids = Array(targets).compact.uniq
      where(id: ids) if ids.any?
    end
  end
  private_class_method :sync_config_cache_bump_scope

  # The single place secret order is decided for every sync array. iron-proxy
  # applies matching transforms in array order and the LAST one wins, so we emit
  # in ASCENDING priority: the highest-priority grant lands last and becomes
  # authoritative. A secret reachable by several grants (e.g. both directly and
  # via a role) collapses to one row taking the strongest priority among them
  # (MAX), and the id tiebreak keeps the order deterministic for config_hash.
  # The selected effective_priority also drives cross-type conflict resolution
  # when PrincipalSyncConfigSnapshot assembles a payload.
  #
  # Do NOT add an `.order(:id)`-style sort to the per-type callers above or emit
  # grants in any other order downstream: that would silently let the wrong
  # credential win. `foreign_key` and the model table name are internal symbols,
  # never user input.
  def granted_secrets_by_priority(model, foreign_key, includes:)
    priorities = effective_grants
      .where.not(foreign_key => nil)
      .group(foreign_key)
      .select("#{foreign_key} AS secret_id, MAX(priority) AS effective_priority")

    model
      .joins("INNER JOIN (#{priorities.to_sql}) granted_priorities " \
             "ON granted_priorities.secret_id = #{model.table_name}.id")
      .select("#{model.table_name}.*", "granted_priorities.effective_priority")
      .includes(*includes)
      .order(Arel.sql("granted_priorities.effective_priority ASC, #{model.table_name}.id ASC"))
  end

  def sync_config_fields_changed?
    %w[
      name labels sandbox_api_server_enabled kind slack_user_id slack_channel_id slack_team_id slack_email
      console_user_id console_user_email
    ].any? do |field|
      previous_changes.key?(field)
    end
  end

  def bump_own_sync_config_cache_version
    self.class.bump_sync_config_cache_versions(id)
  end
end
