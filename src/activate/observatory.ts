import * as vscode from "vscode"
import * as path from "node:path"
import type { WebviewMessage } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import {
	TaskObservationService,
	type ObservableProvider,
	type GetAllInstances,
} from "../services/observatory/TaskObservationService"
import { ObservatoryMessageRouter } from "../services/observatory/ObservatoryMessageRouter"

/** Module-scoped router — set during activation, checked during message dispatch. */
let activeRouter: ObservatoryMessageRouter | undefined

/**
 * Registers the read-only TaskObservationService during activation and wires
 * the ObservatoryMessageRouter for read-only webview requests.
 *
 * The service is registered as a context Disposable and the router is stored
 * module-locally for {@link handleObservatoryMessage} to delegate to.
 */
export function registerObservatory(
	context: vscode.ExtensionContext,
	provider: ClineProvider,
): void {
	const observableProvider = provider as unknown as ObservableProvider
	const getAllInstances: GetAllInstances = () =>
		ClineProvider.getAllInstances() as unknown as ObservableProvider[]

	const service = new TaskObservationService(getAllInstances)
	service.start(observableProvider)
	context.subscriptions.push(service)

	const parallelTasksDir = path.join(context.globalStorageUri.fsPath, "parallel-tasks")
	activeRouter = new ObservatoryMessageRouter({
		service,
		provider: observableProvider,
		getAllInstances,
		parallelTasksDir,
	})
}

/**
 * Attempts to handle an observatory read-only message via the router.
 * Returns true if the message was an observatory message and handled.
 */
export async function handleObservatoryMessage(message: WebviewMessage): Promise<boolean> {
	if (!activeRouter) return false
	return activeRouter.handle(message)
}
