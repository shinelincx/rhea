import { createApp } from './create-app.js';
import { createConfiguredJobClient } from './jobs/create-configured-job-client.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

const app = await createApp({ jobClient: createConfiguredJobClient(process.env) });
await app.listen(port, host);
