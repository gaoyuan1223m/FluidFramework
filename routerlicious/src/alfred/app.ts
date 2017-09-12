import * as bodyParser from "body-parser";
import * as compression from "compression";
import * as express from "express";
import { Express } from "express";
import * as fs from "fs";
import * as morgan from "morgan";
import { Provider } from "nconf";
import * as passport from "passport";
import * as path from "path";
import * as favicon from "serve-favicon";
import split = require("split");
import * as expiry from "static-expiry";
import * as winston from "winston";
import * as git from "../git-storage";
import * as utils from "../utils";
import * as routes from "./routes";

// Base endpoint to expose static files at
const staticFilesEndpoint = "/public";

// Helper function to translate from a static files URL to the path to find the file
// relative to the static assets directory
export function translateStaticUrl(
    url: string,
    cache: { [key: string]: string },
    furl: Function,
    production: boolean): string {

    const local = url.substring(staticFilesEndpoint.length);
    if (!(local in cache)) {
        const parsedPath = path.parse(local);
        parsedPath.name = `${parsedPath.name}.min`;
        // base and root are marked undefined to placate the TS definitions and because we want the format to
        // resolve with dir/ext/name. Base and root if defined will override.
        const minified = path.format({
            base: undefined,
            dir: parsedPath.dir,
            ext: parsedPath.ext,
            name: parsedPath.name,
            root: undefined,
        });

        // Cache the result and then update local
        winston.info(path.join(__dirname, "../../public", minified));
        cache[local] =
            production && fs.existsSync(path.join(__dirname, "../../public", minified))
                ? minified
                : local;
    }

    return staticFilesEndpoint + furl(cache[local]);
}

/**
 * Basic stream logging interface for libraries that require a stream to pipe output to (re: Morgan)
 */
const stream = split().on("data", (message) => {
    winston.info(message);
});

export function create(config: Provider, gitManager: git.GitManager, mongoManager: utils.MongoManager) {
    // Maximum REST request size
    const requestSize = config.get("alfred:restJsonSize");

    // Static cache to help map from full to minified files
    const staticMinCache: { [key: string]: string } = {};

    // Express app configuration
    let app: Express = express();

    // Running behind iisnode
    app.set("trust proxy", 1);

    // view engine setup
    app.set("views", path.join(__dirname, "../../views"));
    app.set("view engine", "hjs");

    app.use(compression());
    app.use(favicon(path.join(__dirname, "../../public", "favicon.ico")));
    // TODO we probably want to switch morgan to use the common format in prod
    app.use(morgan(config.get("logger:morganFormat"), { stream }));
    app.use(bodyParser.json({ limit: requestSize }));
    app.use(bodyParser.urlencoded({ limit: requestSize, extended: false }));

    app.use(staticFilesEndpoint, expiry(app, { dir: path.join(__dirname, "../../public") }));
    app.locals.hfurl = () => (value: string) => {
        return translateStaticUrl(
            value,
            staticMinCache,
            app.locals.furl,
            app.get("env") === "production");
    };
    app.use(staticFilesEndpoint, express.static(path.join(__dirname, "../../public")));
    app.use(passport.initialize());
    app.use(passport.session());

    const gitSettings = config.get("git");
    git.getOrCreateRepository(gitSettings.historian, gitSettings.repository).catch((error) => {
        winston.error(`Error creating ${gitSettings.repository} repository`, error);
    });

    // bind routes
    const foo = routes.create(config, gitManager, mongoManager);
    app.use("/deltas", foo.deltas);
    app.use("/maps", foo.maps);
    app.use("/canvas", foo.canvas);
    app.use("/sharedText", foo.sharedText);
    app.use("/cell", foo.cell);
    app.use("/scribe", foo.scribe);
    app.use("/intelligence", foo.intelligence);
    app.use("/democreator", foo.demoCreator);
    app.use("/login", foo.login);
    app.use(foo.home);

    // catch 404 and forward to error handler
    app.use((req, res, next) => {
        let err = new Error("Not Found");
        (<any> err).status = 404;
        next(err);
    });

    // error handlers

    // development error handler
    // will print stacktrace
    if (app.get("env") === "development") {
        app.use((err, req, res, next) => {
            res.status(err.status || 500);
            res.render("error", {
                error: err,
                message: err.message,
            });
        });
    }

    // production error handler
    // no stacktraces leaked to user
    app.use((err, req, res, next) => {
        res.status(err.status || 500);
        res.render("error", {
            error: {},
            message: err.message,
        });
    });

    return app;
};
