import { requirePluginSelf } from "../../utils/worker-auth";
import { WorkerSelfStorageDomain } from "../../utils/worker-self-storage-domain";
export default defineEventHandler(async (event) => new WorkerSelfStorageDomain().invoke(await requirePluginSelf(event), "storage.add", await readBody(event)));
