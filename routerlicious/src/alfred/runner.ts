import * as http from "http";
import { Provider } from "nconf";
import * as winston from "winston";
import * as git from "../git-storage";
import * as shared from "../shared";
import * as utils from "../utils";
import * as app from "./app";
import * as io from "./io";

export class AlfredRunner implements utils.IRunner {
    private server: http.Server;
    private runningDeferred: shared.Deferred<void>;

    constructor(
        private config: Provider,
        private port: string | number,
        private gitManager: git.GitManager,
        private mongoManager: utils.MongoManager) {
    }

    public start(): Promise<void> {
        this.runningDeferred = new shared.Deferred<void>();

        // Create the HTTP server and attach alfred to it
        const alfred = app.create(this.config, this.gitManager, this.mongoManager);
        alfred.set("port", this.port);
        this.server = http.createServer(alfred);

        // Attach socket.io connections
        const alfredIo = io.create(this.config);
        alfredIo.attach(this.server);

        // Listen on provided port, on all network interfaces.
        this.server.listen(this.port);
        this.server.on("error", (error) => this.onError(error));
        this.server.on("listening", () => this.onListening());

        return this.runningDeferred.promise;
    }

    public stop(): Promise<void> {
        // Close the underlying server and then resolve the runner once closed
        this.server.close((error) => {
            if (error) {
                this.runningDeferred.reject(error);
            } else {
                this.runningDeferred.resolve();
            }
        });

        return this.runningDeferred.promise;
    }

    /**
     * Event listener for HTTP server "error" event.
     */
    private onError(error) {
        if (error.syscall !== "listen") {
            throw error;
        }

        let bind = typeof this.port === "string"
            ? "Pipe " + this.port
            : "Port " + this.port;

        // handle specific listen errors with friendly messages
        switch (error.code) {
            case "EACCES":
                this.runningDeferred.reject(`${bind} requires elevated privileges`);
                break;
            case "EADDRINUSE":
                this.runningDeferred.reject(`${bind} is already in use`);
                break;
            default:
                throw error;
        }
    }

    /**
     * Event listener for HTTP server "listening" event.
     */
    private onListening() {
        let addr = this.server.address();
        let bind = typeof addr === "string"
            ? "pipe " + addr
            : "port " + addr.port;
        winston.info("Listening on " + bind);
    }
}
