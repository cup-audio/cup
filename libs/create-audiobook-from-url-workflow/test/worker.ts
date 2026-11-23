import { WorkflowEntrypoint } from "cloudflare:workers";

import { AccountDurableObject as BaseAccountDurableObject } from "@cup/accounts";
import { ConversionGrantDurableObject as BaseConversionGrantDurableObject } from "@cup/conversion-grants";

export class AccountDurableObject extends BaseAccountDurableObject {
  reconcileForTest() {
    return this.alarm();
  }
}

export class ConversionGrantDurableObject extends BaseConversionGrantDurableObject {
  reconcileForTest() {
    return this.alarm();
  }
}

export class DispatchedAudioSegmentWorkflow extends WorkflowEntrypoint {
  override async run() {}
}

export default {
  fetch: () => new Response("Workflow integration test Worker"),
} satisfies ExportedHandler;

export { RegistryDurableObject } from "@cup/registry";
