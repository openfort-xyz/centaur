namespace :api do
  namespace :v1 do
    namespace :console do
      resources :roles, only: %i[index show create update destroy] do
        member do
          put "slack_channel_permissions", action: :replace_slack_channel_permissions
          delete "slack_channel_permissions/:channel_id", action: :destroy_slack_channel_permission,
                 as: :slack_channel_permission, constraints: { channel_id: /[^\/]+/ }
          put "google_chat_space_permissions", action: :replace_google_chat_space_permissions
          delete "google_chat_space_permissions/spaces/:space_id", action: :destroy_google_chat_space_permission,
                 as: :google_chat_space_permission, constraints: { space_id: /[^\/]+/ }, format: false
          put "google_chat_dm_permissions", action: :replace_google_chat_dm_permissions
          delete "google_chat_dm_permissions/:target_identity", action: :destroy_google_chat_dm_permission,
                 as: :google_chat_dm_permission, constraints: { target_identity: /[^\/]+/ }, format: false
        end
        # Grants whose grantee is this role.
        resources :grants, only: %i[index], controller: :grantee_grants
      end
    end
  end
end
