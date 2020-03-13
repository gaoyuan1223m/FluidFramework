/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as assert from "assert";
import { EventEmitter } from "events";
import { DebugLogger } from "@microsoft/fluid-common-utils";
import {
    IClient,
    ISequencedDocumentMessage,
    MessageType,
} from "@microsoft/fluid-protocol-definitions";
import { DeltaManager } from "@microsoft/fluid-container-loader";
import { MockDocumentDeltaConnection, MockDocumentService } from "@microsoft/fluid-test-loader-utils";
import { ScheduleManager, DeltaScheduler } from "@microsoft/fluid-container-runtime";

describe("Container Runtime", () => {
    /**
     * The following tests test the async processing model of ContainerRuntime -
     * Batch messages are processed in a single turn no matter how long it takes to process them.
     * Non-batch messages are processed in multiple turns if they take longer than DeltaScheduler's processingTime.
     */
    describe("Async op processing", () => {
        let deltaManager: DeltaManager;
        let scheduleManager: ScheduleManager;
        let deltaConnection: MockDocumentDeltaConnection;
        let seq: number;
        const docId = "docId";
        let batchBegin: number = 0;
        let batchEnd: number = 0;

        async function startDeltaManager() {
            await deltaManager.connect();
            deltaManager.inbound.resume();
            deltaManager.outbound.resume();
            deltaManager.inboundSignal.resume();
            deltaManager.updateQuorumJoin();
        }

        // Function to yield control in the Javascript event loop.
        async function yieldEventLoop(): Promise<void> {
            await new Promise<void>((resolve) => {
                setTimeout(resolve);
            });
        }

        async function emitMessages(messages: ISequencedDocumentMessage[]) {
            deltaConnection.emitOp(docId, messages);
            // Yield the event loop because the inbound op will be processed asynchronously.
            await yieldEventLoop();
        }

        function getMessages(clientId: string, count: number): ISequencedDocumentMessage[] {
            const messages: Partial<ISequencedDocumentMessage>[] = [];
            for (let i = 0; i < count; i++) {
                const message: Partial<ISequencedDocumentMessage> = {
                    clientId,
                    minimumSequenceNumber: 0,
                    sequenceNumber: seq++,
                    type: MessageType.Operation,
                };
                messages.push(message);
            }

            return messages as ISequencedDocumentMessage[];
        }

        // function to process an inbound op. It adds a 1 ms delay per op.
        function processOp(message: ISequencedDocumentMessage) {
            scheduleManager.beginOperation(message);

            const startTime = Date.now();
            while (Date.now() - startTime < 1) {}

            scheduleManager.endOperation(undefined, message);
        }

        beforeEach(() => {
            seq = 1;
            deltaConnection = new MockDocumentDeltaConnection(
                "test",
            );
            const service = new MockDocumentService(
                undefined,
                () => deltaConnection,
            );
            const client: Partial<IClient> = { mode: "write", details: { capabilities: { interactive: true } } };

            deltaManager = new DeltaManager(
                () => service,
                client as IClient,
                DebugLogger.create("fluid:testDeltaManager"),
                false,
            );

            const emitter = new EventEmitter();
            scheduleManager = new ScheduleManager(
                deltaManager,
                emitter,
                DebugLogger.create("fluid:testScheduleManager"),
            );

            emitter.on("batchBegin", () => {
                // When we receive a "batchBegin" event, we should not have any outstanding
                // events, i.e., batchBegin and batchEnd should be equal.
                assert.strictEqual(batchBegin, batchEnd, "Received batchBegin before previous batchEnd");
                batchBegin++;
            });

            emitter.on("batchEnd", () => {
                batchEnd++;
                // Every "batchEnd" event should correspond to a "batchBegin" event, i.e.,
                // batchBegin and batchEnd should be equal.
                assert.strictEqual(batchBegin, batchEnd, "Received batchEnd without corresponding batchBegin");
            });

            deltaManager.attachOpHandler(0, 0, {
                process(message: ISequencedDocumentMessage) {
                    processOp(message);
                    return {};
                },
                processSignal() {},
            }, true);
        });

        afterEach(() => {
            batchBegin = 0;
            batchEnd = 0;
        });

        it("Batch messages that take longer than DeltaScheduler's processing time to process", async () => {
            await startDeltaManager();
            // Since each message will take ~1 ms to process, we can use DeltaScheduler's processingTime as
            // a reference for the number of messages we sent.
            const count = DeltaScheduler.processingTime * 2;
            const clientId: string = "test-client";

            const messages: ISequencedDocumentMessage[] = getMessages(clientId, count);
            // Add batch begin and batch end metadata to the messages.
            messages[0].metadata = { batch: true };
            messages[count - 1].metadata = { batch: false };
            await emitMessages(messages);

            // Batch messages are processed in a single turn. So, we should have received the batch events.
            assert.strictEqual(1, batchBegin, "Did not receive correct batchBegin event for the batch");
            assert.strictEqual(1, batchEnd, "Did not receive correct batchEnd event for the batch");
        });

        it("Non-batch messages that take longer than DeltaScheduler's processing time to process", async () => {
            await startDeltaManager();
            // Since each message will take ~1 ms to process, we can use DeltaScheduler's processingTime as
            // a reference for the number of messages we sent.
            const count = DeltaScheduler.processingTime * 2;
            const clientId: string = "test-client";
            let numberOfTurns = 1;

            const messages: ISequencedDocumentMessage[] = getMessages(clientId, count);
            await emitMessages(messages);

            // Non-batch messages should take more than one turn. Keep yielding until we get all the
            // batch events.
            while (batchBegin < count) {
                numberOfTurns++;
                await yieldEventLoop();
            }

            // Assert that the processing should have happened in more than one turn.
            assert.strict(numberOfTurns > 1, "The processing should have taken more than one turn");

            // We should have received all the batch events.
            assert.strictEqual(count, batchBegin, "Did not receive correct batchBegin event for the batch");
            assert.strictEqual(count, batchEnd, "Did not receive correct batchEnd event for the batch");
        });

        it(`A non-batch message followed by batch messages that take longer than
            DeltaScheduler's processing time to process`, async () => {
            await startDeltaManager();
            // Since each message will take ~1 ms to process, we can use DeltaScheduler's processingTime as
            // a reference for the number of messages we sent.
            const count = DeltaScheduler.processingTime * 2;
            const clientId: string = "test-client";

            const messages: ISequencedDocumentMessage[] = getMessages(clientId, count);
            // Add batch begin and batch end metadata to the messages.
            messages[1].metadata = { batch: true };
            messages[count - 1].metadata = { batch: false };
            await emitMessages(messages);

            // The messages should be processed in a single turn. So, we should have received the batch events.
            assert.strictEqual(2, batchBegin, "Did not receive correct batchBegin event for the batch");
            assert.strictEqual(2, batchEnd, "Did not receive correct batchEnd event for the batch");
        });

        it(`Batch messages followed by a non-batch message that take longer than
            DeltaScheduler's processing time to process`, async () => {
            await startDeltaManager();
            // Since each message will take ~1 ms to process, we can use DeltaScheduler's processingTime as
            // a reference for the number of messages we sent.
            const count = DeltaScheduler.processingTime * 2;
            const clientId: string = "test-client";

            const messages: ISequencedDocumentMessage[] = getMessages(clientId, count);
            // Add batch begin and batch end metadata to the messages.
            messages[0].metadata = { batch: true };
            messages[count - 2].metadata = { batch: false };
            await emitMessages(messages);

            // We should have only received the batch events for the batch messages in this turn.
            assert.strictEqual(1, batchBegin, "Did not receive correct batchBegin event for the batch");
            assert.strictEqual(1, batchEnd, "Did not receive correct batchEnd event for the batch");

            // Yield the event loop so that the single non-batch event can be processed.
            await yieldEventLoop();

            // We should have received the batch events for the non-batch event as well.
            assert.strictEqual(2, batchBegin, "Did not receive correct batchBegin event for the batch");
            assert.strictEqual(2, batchEnd, "Did not receive correct batchEnd event for the batch");
        });
    });
});