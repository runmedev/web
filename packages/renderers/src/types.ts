import { type TerminalDimensions } from 'vscode'

export enum ClientMessages {
  infoMessage = 'common:infoMessage',
  errorMessage = 'common:errorMessage',
  closeCellOutput = 'common:closeCellOutput',
  displayPrompt = 'common:displayPrompt',
  onPrompt = 'common:onPrompt',
  setState = 'common:setState',
  getState = 'common:getState',
  onGetState = 'common:onGetState',
  onCategoryChange = 'common:onCategoryChange',
  platformApiRequest = 'common:platformApiRequest',
  platformApiResponse = 'common:platformApiResponse',
  optionsMessage = 'common:optionsMessage',
  optionsModal = 'common:optionsModal',
  openExternalLink = 'common:openExternalLink',
  onOptionsMessage = 'common:onOptionsMessage',
  copyTextToClipboard = 'common:copyTextToClipboard',
  onCopyTextToClipboard = 'common:onCopyTextToClipboard',
  onProgramClose = 'common:onProgramClose',
  denoUpdate = 'deno:deploymentUpdate',
  denoPromote = 'deno:promoteDeployment',
  vercelProd = 'vercel:promotePreview',
  mutateAnnotations = 'annotations:mutate',
  terminalStdout = 'terminal:stdout',
  terminalStderr = 'terminal:stderr',
  terminalStdin = 'terminal:stdin',
  terminalResize = 'terminal:resize',
  terminalFocus = 'terminal:focus',
  terminalOpen = 'terminal:open',
  openLink = 'terminal:openLink',
  activeThemeChanged = 'theme:changed',
  githubWorkflowDispatch = 'github:workflowDispatch',
  githubWorkflowDeploy = 'github:workflowDeploy',
  githubWorkflowStatusUpdate = 'github:workflowStatusUpdate',
  tangleEvent = 'tangle:event',
  gcpResourceStatusChanged = 'gcp:resourceStatusChanged',
  gcpClusterCheckStatus = 'gcp:clusterCheckStatus',
  gcpClusterDetails = 'gcp:clusterDetails',
  gcpClusterDetailsNewCell = 'gcp:clusterDetailsNewCell',
  gcpClusterDetailsResponse = 'gcp:clusterDetailsResponse',
  gcpVMInstanceAction = 'gcp:gceVMInstanceAction',
  awsEC2Instances = 'aws:ec2Instances',
  awsEC2InstanceAction = 'aws:ec2InstanceAction',
  awsEKSClusterAction = 'aws:eksClusterAction',
  onAuthorModeChange = 'common:onAuthorModeChange',
  gistCell = 'gist:cell',
  gcpCloudRunAction = 'gcp:cloudRunAction',
  gcpLoadServices = 'gcp:loadServices',
  gcpServicesLoaded = 'gcp:servicesLoaded',
  daggerSyncState = 'dagger:syncState',
  daggerCliAction = 'dagger:cliAction',
  featuresUpdateAction = 'features:updateAction',
  featuresRequest = 'features:request',
  featuresResponse = 'features:response',
}

export type ClientMessage<T extends keyof ClientMessagePayload> = T extends any
  ? {
      type: T
      output: ClientMessagePayload[T]
    }
  : never

export interface ClientMessagePayload {
  [ClientMessages.mutateAnnotations]: {
    annotations: any
  }
  [ClientMessages.infoMessage]: string
  [ClientMessages.errorMessage]: string
  [ClientMessages.terminalStdout]: {
    ['runme.dev/id']: string
    data: Uint8Array | string
  }
  [ClientMessages.terminalStderr]: {
    ['runme.dev/id']: string
    data: Uint8Array | string
  }
  [ClientMessages.terminalStdin]: {
    ['runme.dev/id']: string
    input: string
  }
  [ClientMessages.terminalFocus]: { ['runme.dev/id']: string }
  [ClientMessages.terminalResize]: {
    ['runme.dev/id']: string
    terminalDimensions: TerminalDimensions
  }
  [ClientMessages.terminalOpen]: {
    ['runme.dev/id']: string
    terminalDimensions?: TerminalDimensions
  }
  [ClientMessages.onProgramClose]: {
    ['runme.dev/id']: string
    code: number | void
  }
  [ClientMessages.activeThemeChanged]: string
  [ClientMessages.openLink]: string
  [ClientMessages.displayPrompt]: {
    placeholder: string
    isSecret: boolean
    title: string
    id: string
  }
  [ClientMessages.onPrompt]: {
    answer: string | undefined
    id: string
  }
  [ClientMessages.onCategoryChange]: void
  [ClientMessages.setState]: {
    state: string
    value: string[]
    id: string
  }
  [ClientMessages.getState]: {
    state: string
    id: string
  }
  [ClientMessages.onGetState]: {
    state: string
    value: string | string[]
    id: string
  }
  [ClientMessages.optionsModal]: {
    title: string
    id: string
    options: any[]
    telemetryEvent?: string
  }
  [ClientMessages.optionsMessage]: {
    title: string
    id: string
    options: any[]
    modal?: boolean
    telemetryEvent?: string
  }
  [ClientMessages.onOptionsMessage]: {
    id: string
    option: string | undefined
  }
  [ClientMessages.openExternalLink]: {
    link: string
    telemetryEvent: string
  }
  [ClientMessages.copyTextToClipboard]: {
    id: string
    text: string
  }
  [ClientMessages.onCopyTextToClipboard]: {
    id: string
  }
  [ClientMessages.tangleEvent]: {
    data: any
    webviewId: string
  }
  [ClientMessages.gcpClusterCheckStatus]: {
    clusterName: string
    projectId: string
    location: string
    cellId: string
    clusterId: string
    status: string
  }
  [ClientMessages.gcpResourceStatusChanged]: {
    resourceId: string
    status: string
    cellId: string
    hasErrors: boolean
    error?: string | undefined
  }
  [ClientMessages.gcpClusterDetails]: {
    cellId: string
    cluster: string
    location: string
    projectId: string
  }
  [ClientMessages.gcpClusterDetailsResponse]: {
    cellId: string
    itFailed: boolean
    reason: string
    data: any
    executedInNewCell: boolean
    cluster: string
  }
  [ClientMessages.gcpClusterDetailsNewCell]: {
    cellId: string
    cluster: string
    location: string
    project: string
  }
  //   [ClientMessages.gcpVMInstanceAction]: {
  //     cellId: string
  //     instance: string
  //     zone: string
  //     project: string
  //     status: InstanceStatusType
  //     action: GceActionType
  //   }
  //   [ClientMessages.awsEC2Instances]: {
  //     cellId: string
  //     region: string
  //     view: AWSSupportedView
  //   }
  //   [ClientMessages.awsEC2InstanceAction]: {
  //     cellId: string
  //     instance: string
  //     osUser: string
  //     region: string
  //     action: AWSActionType
  //   }
  [ClientMessages.onAuthorModeChange]: {
    isAuthorMode: boolean
  }

  [ClientMessages.gistCell]: {
    cellId: string
    telemetryEvent: string
  }

  //   [ClientMessages.gcpCloudRunAction]: {
  //     cellId: string
  //     resource?: string | undefined
  //     project: string
  //     resourceType?: 'revisions' | 'services'
  //     region?: string
  //     action: GCPCloudRunActionType
  //   }

  //   [ClientMessages.gcpLoadServices]: {
  //     cellId: string
  //     project: string
  //   }

  //   [ClientMessages.gcpServicesLoaded]: {
  //     cellId: string
  //     services?: GcpCloudRunService[] | undefined
  //     region?: string | undefined
  //     allRegionsLoaded: boolean
  //     hasError: boolean
  //     error?: string | undefined
  //   }

  //   [ClientMessages.awsEKSClusterAction]: {
  //     cellId: string
  //     cluster: string
  //     region: string
  //     action: AWSActionType
  //   }

  //   [ClientMessages.daggerSyncState]: {
  //     id: string
  //     cellId: string
  //     text?: string
  //     json?: any
  //     state?: DaggerState
  //   }

  //   [ClientMessages.daggerCliAction]: {
  //     cellId: string
  //     command: string
  //     argument?: string
  //   }

  [ClientMessages.featuresUpdateAction]: {
    snapshot: string
  }

  [ClientMessages.featuresRequest]: {}

  [ClientMessages.featuresResponse]: {
    snapshot: string
  }
}

export enum OutputType {
  vercel = 'stateful.runme/vercel-stdout',
  deno = 'stateful.runme/deno-stdout',
  outputItems = 'stateful.runme/output-items',
  annotations = 'stateful.runme/annotations',
  terminal = 'stateful.runme/terminal',
  error = 'stateful.runme/error',
  github = 'stateful.runme/github-stdout',
  stdout = 'application/vnd.code.notebook.stdout',
  gcp = 'stateful.runme/gcp',
  aws = 'stateful.runme/aws',
  daggerCall = 'stateful.runme/dagger',
  daggerShell = 'stateful.runme/dagger',
}

export enum WebViews {
  RunmeCloud = 'runme.cloud',
  RunmeChat = 'runme.chat',
  RunmeSearch = 'runme.search',
  NotebookEnvStore = 'runme.notebook.envStore',
}
