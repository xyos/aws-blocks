# LLM calls: Amazon Bedrock and the Agent block

> Read when: the app calls an LLM provider (OpenAI, Anthropic, an AI gateway, the Vercel AI SDK) or has a chat UI.

## Decide per call

- Convert general-purpose text generation (chat completion, summarizing, classification, extraction, JSON output) to Amazon Bedrock. The call then authenticates with the function's IAM role, so the provider key leaves the app.
- Keep a provider whose value Bedrock does not reproduce for this app: web search, speech, a specific image or video model, a fine-tuned model. Leave the call as it is and move its key to a `Secret` (see `cdk-blocks migrate guide secrets`). Record the key in `MIGRATION.md` under After deploy.
- When the user did not ask for a provider change, keeping every provider with its key in a `Secret` is also a valid migration. Record the choice in `MIGRATION.md`.
- After a conversion, delete the converted provider's key from code and env files.

## Where the call runs

- Put each converted call in an `ApiNamespace` method (or a `RawRoute`) in `aws-blocks/`. Every Blocks compute runs as one shared execution role, and that role is where you add the Bedrock grant.
- Construct the client once at module level: `new BedrockRuntimeClient({})`. On AWS it takes the Region and the role credentials from the function environment.
- Declare `@aws-sdk/client-bedrock-runtime` in `aws-blocks/package.json` `dependencies`, because `aws-blocks/` is the package that imports it.
- A call that stays in Next.js server code (route handler, server action, server component) runs in the SSR function. That function is a different Lambda with a different role, so the grant below does not reach it. See "Vercel AI SDK" for the SSR grant.

## IAM grant

No Building Block grants Bedrock to the shared role. Add the grant in `aws-blocks/index.cdk.ts` after `BlocksStack.create`, outside the `if (!sandboxMode || previewMode)` block, so that a sandbox gets it too:

```typescript
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

blocksStack.executionRole.addToPrincipalPolicy(new PolicyStatement({
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: [
    `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/*`,
    `arn:${cdk.Aws.PARTITION}:bedrock:*:*:inference-profile/*`,
  ],
}));
```

- Keep both resource patterns. An inference profile routes the request to the foundation model in other Regions, so the call is authorized against the profile and against the model.
- The `Agent` block uses the same two patterns for its own runtime role. Narrow them to one model when the app uses one model.
- Every synth writes the composed policy of the shared role to `cdk.out/<stack>.blocks-iam.json`. After `npx cdk synth`, confirm that the Bedrock statement is in it.
- Local mocks do not enforce IAM. A missing grant passes every local check and fails on AWS with `AccessDeniedException`.

## Converse API

The snippet uses the AWS SDK for JavaScript v3; confirm request fields in the Amazon Bedrock API reference.

```typescript
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
const bedrock = new BedrockRuntimeClient({});

const res = await bedrock.send(new ConverseCommand({
  modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  system: [{ text: systemPrompt }],
  messages: [{ role: 'user', content: [{ text: prompt }] }],
  inferenceConfig: { maxTokens: 1024 },
}), { abortSignal: context.request.signal });
const text = res.output?.message?.content?.find((c) => c.text)?.text ?? '';
```

- `modelId` is an inference profile id. `global.` profiles route to any supported Region; `us.`, `eu.` and `apac.` profiles keep requests in one geography. A global profile and a regional profile are separate: access to one does not prove access to the other.
- `context.request.signal` fires just before the platform timeout on AWS and is `undefined` in local dev.
- Structured output (JSON mode, function calling): pass `toolConfig: { tools: [{ toolSpec: { name, description, inputSchema: { json: schema } } }], toolChoice: { tool: { name } } }`. Read the result from the `toolUse` content block: `content.find((c) => c.toolUse)?.toolUse?.input`. It is already an object.
- Under `cdk-blocks dev` this code calls the real Bedrock with the developer's own AWS credentials. Without credentials the call fails locally; that is an environment limit, so record it instead of adding a fake response.

## Limits of an HTTP response

- An API method and a `RawRoute` return one buffered response. `ctx.response.send(body)` sends a string as it is and serializes any other value with `JSON.stringify`, on AWS and in the dev server. A `ReadableStream` passed to `send` arrives as `{}`.
- API Gateway ends a request after 29 seconds and caps the payload at 10 MB. Local mocks do not apply AWS limits, so a slow completion can pass locally and time out on AWS.
- For a completion that can exceed 29 seconds, return a job id from an `AsyncJob` (see `cdk-blocks migrate guide jobs`) or use the `Agent` block. For token-by-token output, use the `Agent` block.

## Agent block

Use it for chat with history, tool calling, token streaming, or long turns. Full docs: `node_modules/@aws-blocks/blocks/docs/bb-agent/README.md`.

```typescript
import { Agent, BedrockModels } from '@aws-blocks/blocks';

const agent = new Agent(scope, 'assistant', {
  systemPrompt: 'You are a helpful assistant.',
  model: { deployed: BedrockModels.FAST },
  streamingMode: 'token',
});
```

- Options: `model: { deployed, local? }`, `systemPrompt`, `tools`, `toolContextSchema`, `inferenceOnly` (default `false`), `sessionScope`, `conversation`, `streamingMode` (`'block'` default, `'token'`), `maxLlmCalls` and `maxToolIterations` (default `20` each; `false` disables).
- Presets: `BedrockModels.BALANCED` (`global.anthropic.claude-sonnet-4-6`, the default when `model` is omitted), `SMART` (`global.anthropic.claude-opus-4-8`), `FAST` (`global.anthropic.claude-haiku-4-5-20251001-v1:0`). For a regional profile pass `{ provider: 'bedrock', modelId: 'us.…' }`. `{ provider: 'openai-api', modelId, endpoint, apiKey }` keeps an OpenAI-compatible provider.
- It provisions an Amazon Bedrock AgentCore Runtime (the loop runs there, sessions up to 8 hours), a `Realtime` WebSocket, a `FileBucket`, and two `DistributedTable`s (skipped with `inferenceOnly: true`). The runtime role gets the Bedrock invoke permissions, so the grant above is only for direct SDK calls.
- `agent.stream(message, { conversationId, userId })` returns at once; chunks reach the browser over `Realtime`, outside the 29-second limit. Take `userId` from the session (`user.userSub`), because ownership checks trust the value you pass.
- Tools need `zod` ^4 (peer dependency). Put it in `aws-blocks/package.json` so that a frontend on Zod 3 is not affected.
- Frontend: `createChat` and `realtimeTransport` from `@aws-blocks/bb-agent/client`, wired to API methods that wrap `getChannel`, `stream`, `resume`, `createConversationId`, `getConversation` and `getPendingInterrupts`. Copy the wiring from the README section "Client API — `createChat`". Call `createChat` once (in React, hold it in a `useRef`), in client-side code only. Declare `@aws-blocks/bb-agent` as a dependency of the package that imports the client.
- Local behavior: the agent answers with the canned provider, a keyword-based mock that needs no credentials. Local checks prove the wiring, and they say nothing about model access. Set `model.local` to an `openai-api` config (for example Ollama) for real answers.

## Vercel AI SDK (`ai`, `@ai-sdk/*`)

General knowledge about the AI SDK, not verified against AWS Blocks sources; confirm in the AI SDK docs for the installed version.

- `generateText` / `generateObject` with `@ai-sdk/amazon-bedrock` work inside an `ApiNamespace` method: they return a complete value. The provider reads AWS credentials from the environment, which the Lambda function sets. Add the IAM grant above.
- `streamText` with `useChat` needs a streaming HTTP response, which an API method and a `RawRoute` cannot give. Two options:
  - Keep the Next.js route handler. With the default CloudFront door, Hosting serves Next.js through a streaming server function. Swap the provider to `@ai-sdk/amazon-bedrock` and grant Bedrock to the SSR function: keep the construct (`const hosting = new Hosting(…)`) and call `hosting.ssrFunction?.addToRolePolicy(statement)` (with `compute.type: 'web-function'`: `hosting.ssrWebFunction?.addToRolePolicy(statement)`). The SSR function timeout is `compute.timeout` on `Hosting`. See `cdk-blocks migrate guide nextjs`.
  - Replace `useChat` with the `Agent` block and `createChat`. Choose this for an SPA, where no SSR function exists.
- `sandbox preview` serves the frontend through API Gateway with buffered server responses of about 6 MB, so a streaming route is verified on a production deploy only.

## Record in MIGRATION.md

Under Before deploy, kind `account`. These steps need no deployed stack, and model calls fail from the first request until they are done:

- Anthropic models (all three presets): submit the one-time use case details form for the account in the Amazon Bedrock console. Until then invocation fails with "Model use case details have not been submitted for this account".
- Models sold through AWS Marketplace (all Anthropic models): invoke the model once as a principal that has `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions`, for example from the console playground. Until then the app's role gets "not authorized to perform the required AWS Marketplace actions".
- With the `Agent` block these refusals surface as `AgentErrors.ModelUnavailable`; the agent's health check still passes.

Under After deploy: the key of every provider that was kept, as `cdk-blocks migrate guide secrets` says. In the task: the model id each call uses.
