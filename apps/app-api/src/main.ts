import { createApp } from './create-app.js';
import { createConfiguredFamilyAccess } from './family-access/create-configured-family-access.js';
import { createConfiguredJobClient } from './jobs/create-configured-job-client.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

const configuredFamilyAccess = createConfiguredFamilyAccess(process.env);
const app = await createApp({
  familyAccess: configuredFamilyAccess.familyAccess,
  jobClient: createConfiguredJobClient(process.env),
  shutdownResources: configuredFamilyAccess.shutdownResources,
});
await app.listen(port, host);
