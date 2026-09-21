@description('ADO MCP Gateway — App Service Linux + Key Vault + App Insights (no Docker)')
param env string = 'dev'
param location string = resourceGroup().location
param namePrefix string = 'adomcp'
@allowed(['B1', 'S1', 'P0v3', 'P1v3'])
param sku string = 'P0v3'
param enableStagingSlot bool = true
@description('Email that receives alerts (5xx, health check, 401 spikes). Leave empty to skip notifications.')
param alertEmail string = ''

var appName = 'app-${namePrefix}-${env}'
var planName = 'plan-${namePrefix}-${env}'
var kvName = take('kv-${namePrefix}-${env}${uniqueString(resourceGroup().id)}', 24)
var lawName = 'law-${namePrefix}-${env}'
var aiName = 'ai-${namePrefix}-${env}'
var slotEnabled = enableStagingSlot && (sku == 'S1' || startsWith(sku, 'P'))

module law 'modules/logAnalytics.bicep' = {
  name: 'law'
  params: {
    name: lawName
    location: location
  }
}

module ai 'modules/appInsights.bicep' = {
  name: 'ai'
  params: {
    name: aiName
    location: location
    workspaceId: law.outputs.id
  }
}

module kv 'modules/keyVault.bicep' = {
  name: 'kv'
  params: {
    name: kvName
    location: location
    workspaceId: law.outputs.id
  }
}

module web 'modules/webApp.bicep' = {
  name: 'web'
  params: {
    appName: appName
    planName: planName
    location: location
    sku: sku
    enableStagingSlot: slotEnabled
    keyVaultUri: kv.outputs.uri
    appInsightsConnectionString: ai.outputs.connectionString
    workspaceId: law.outputs.id
    alertEmail: alertEmail
  }
}

module kvRole 'modules/keyVaultRole.bicep' = {
  name: 'kv-role'
  params: {
    keyVaultName: kv.outputs.name
    principalId: web.outputs.principalId
  }
}

module kvRoleSlot 'modules/keyVaultRole.bicep' = if (slotEnabled) {
  name: 'kv-role-slot'
  params: {
    keyVaultName: kv.outputs.name
    principalId: web.outputs.slotPrincipalId
  }
}

output defaultHostname string = web.outputs.defaultHostname
output principalId string = web.outputs.principalId
output keyVaultUri string = kv.outputs.uri
output keyVaultName string = kv.outputs.name
output webAppName string = appName
