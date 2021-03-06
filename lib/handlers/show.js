var Calibrate = require('calibrate');
var _ = require('lodash');

module.exports = function(server, config, log) {
    "use strict";

    return function(Model) {
        log.trace("initializing model %s show handler", Model.name);
        return function(req, reply) {
            log.debug("Show %s(%s) request", Model.name, req.params.id);
            var opts = _.merge(req.query || {}, { params: req.params || {}, credentials: _.get(req.auth, "credentials") });
            return Model.show(req.params.id, opts).then(Calibrate.response).catch(Calibrate.error).then(reply);
        }
    }

};
