import * as api from "@prague/container-definitions";
import { ICommit, ITree } from "@prague/gitresources";
import { GitManager, Historian, ICredentials } from "@prague/services-client";
import { DocumentDeltaConnection } from "@prague/socket-storage-shared";
import Axios from "axios";
import * as io from "socket.io-client";
import { DocumentStorageService } from "./blobStorageService";
import { DeltaStorageService, DocumentDeltaStorageService } from "./deltaStorageService";
import { TokenProvider } from "./tokens";

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class DocumentService implements api.IDocumentService {
    private deltaStorage: DeltaStorageService;

    constructor(
        protected deltaUrl: string,
        private gitUrl: string,
        private errorTracking: api.IErrorTrackingService,
        private disableCache: boolean,
        private historianApi: boolean,
        private directCredentials: ICredentials,
        private seedData: { commits: ICommit[]; trees: ITree[] }) {

        this.deltaStorage = new DeltaStorageService(this.deltaUrl);
    }

    public async connectToStorage(
        tenantId: string,
        id: string,
        tokenProvider: api.ITokenProvider): Promise<api.IDocumentStorageService> {

        const endpoint = `${this.gitUrl}/repos/${encodeURIComponent(tenantId)}`;

        // Craft credentials - either use the direct credentials (i.e. a GitHub user + PAT) - or make use of our
        // tenant token
        let credentials: ICredentials;
        if (this.directCredentials) {
            credentials = this.directCredentials;
        } else {
            const token = (tokenProvider as TokenProvider).token;
            if (token) {
                credentials = {
                    password: token,
                    user: tenantId,
                };
            }
        }

        const historian = new Historian(
            endpoint,
            this.historianApi,
            this.disableCache,
            credentials);
        const gitManager = new GitManager(historian);

        // Insert cached seed data
        if (this.seedData) {
            for (const commit of this.seedData.commits) {
                gitManager.addCommit(commit);
            }

            for (const tree of this.seedData.trees) {
                gitManager.addTree(tree);
            }
        }

        return new DocumentStorageService(tenantId, id, gitManager);
    }

    public async connectToDeltaStorage(
        tenantId: string,
        id: string,
        tokenProvider: api.ITokenProvider): Promise<api.IDocumentDeltaStorageService> {

        return new DocumentDeltaStorageService(tenantId, id, tokenProvider, this.deltaStorage);
    }

    public async connectToDeltaStream(
        tenantId: string,
        id: string,
        tokenProvider: api.ITokenProvider,
        client: api.IClient): Promise<api.IDocumentDeltaConnection> {
        const token = (tokenProvider as TokenProvider).token;
        return DocumentDeltaConnection.Create(tenantId, id, token, io, client, this.deltaUrl);
    }

    public async branch(tenantId: string, id: string, tokenProvider: api.ITokenProvider): Promise<string> {
        let headers = null;
        const token = (tokenProvider as TokenProvider).token;
        if (token) {
            headers = {
                Authorization: `Basic ${new Buffer(`${tenantId}:${token}`).toString("base64")}`,
            };
        }

        const result = await Axios.post<string>(`${this.deltaUrl}/documents/${tenantId}/${id}/forks`, { headers });
        return result.data;
    }

    public getErrorTrackingService() {
        return this.errorTracking;
    }
}
