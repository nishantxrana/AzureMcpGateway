param appName string
param planName string
param location string
param sku string
param enableStagingSlot bool
param keyVaultUri string
param appInsightsConnectionString string
param workspaceId string
@description('Email that receives alerts. Leave empty to create the alerts without a notification target.')
param alertEmail string = ''

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: sku
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

var appSettings = [
  { name: 'KEY_VAULT_URI', value: keyVaultUri }
  { name: 'NODE_ENV', value: 'production' }
  { name: 'ORG_REGISTRY_PATH', value: 'config/orgs.json' }
  { name: 'CHILD_TIMEOUT_MS', value: '60000' }
  { name: 'MAX_CONCURRENT_CHILDREN', value: '6' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
]

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node dist/index.js'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/healthz'
      remoteDebuggingEnabled: false
      appSettings: appSettings
    }
  }
}

resource slot 'Microsoft.Web/sites/slots@2023-12-01' = if (enableStagingSlot) {
  parent: web
  name: 'staging'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node dist/index.js'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/healthz'
      remoteDebuggingEnabled: false
      appSettings: appSettings
    }
  }
}

resource webDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'web-to-law'
  scope: web
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceAppLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmail)) {
  name: 'ag-${appName}'
  location: 'global'
  properties: {
    groupShortName: take('adomcp', 12)
    enabled: true
    emailReceivers: [
      {
        name: 'oncall'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var alertActions = !empty(alertEmail) ? [ { actionGroupId: actionGroup!.id } ] : []

resource alert5xx 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${appName}-5xx'
  location: 'global'
  properties: {
    description: 'More than 2 HTTP 5xx responses within 5 minutes'
    severity: 2
    enabled: true
    scopes: [web.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Http5xx'
          metricName: 'Http5xx'
          operator: 'GreaterThan'
          threshold: 2
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: alertActions
  }
}

resource alertHealth 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${appName}-healthcheck'
  location: 'global'
  properties: {
    description: 'App Service health check (/healthz) is failing on one or more instances'
    severity: 1
    enabled: true
    scopes: [web.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HealthCheckStatus'
          metricName: 'HealthCheckStatus'
          operator: 'LessThan'
          threshold: 100
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: alertActions
  }
}

// Repeated 401s: leaked/guessed key probing, or a client with a stale key after rotation.
resource alert401 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'alert-${appName}-401'
  location: location
  properties: {
    displayName: 'alert-${appName}-401'
    description: 'More than 30 HTTP 401 responses within 5 minutes'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: 'AppServiceHTTPLogs | where _ResourceId =~ "${web.id}" | where ScStatus == 401'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 30
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: !empty(alertEmail) ? [actionGroup!.id] : []
    }
  }
}

output defaultHostname string = web.properties.defaultHostName
output principalId string = web.identity.principalId
output slotPrincipalId string = enableStagingSlot ? slot!.identity.principalId : ''
output id string = web.id
