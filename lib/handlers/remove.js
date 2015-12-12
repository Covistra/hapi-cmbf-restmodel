var Calibrate = require('calibrate');

module.exports = function(server, config, log) {
    "use strict";

    return function(Model) {
        log.trace("initializing model %s remove handler", Model.name);
        return function(req, reply) {
            log.debug("Remove %s request", Model.name, req.params.id);
            Model.remove(req.params.id).then(Calibrate.response).then(Calibrate.error).then(reply);
        }
    }

};