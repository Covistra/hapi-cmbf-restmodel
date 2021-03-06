var Joi = require('joi'),
    P = require('bluebird'),
    _ = require('lodash');

module.exports = function(server, config, log) {
    "use strict";

    var dbName = config.get('plugins:restmod:dbname','MAIN');
    var random = server.plugins['covistra-system'].random;

    /**
     * key[><=]value;
     */
    var _parseFilter = P.method(function(model, options) {

        if(options.filter) {
            return options.filter;
        }
        else if(options.params && options.params.filter) {
            return options.params.filter;
        }
    });

    class BaseModel {

        constructor(data) {
            _.merge(this, data);
        }

        static get validation() {
            var params = {};
            params.id = Joi.string().required();
            return {
                create: {
                    payload: this.constructor.Schema
                },
                update: {
                    payload: this.constructor.Schema
                },
                upsert: {
                    payload: this.constructor.Schema
                },
                remove: {
                    params: params
                },
                show: {
                    params: params
                },
                list: {
                    query: {
                        filter: Joi.string(),
                        offset: Joi.number().precision(0),
                        size: Joi.number().precision(0)
                    }
                }
            }
        }

        static get auth() {
            return "token";
        }

        static get db() {
            return server.plugins['covistra-mongodb'][dbName];
        }

        // THESE METHODS MUST BE OVERRIDEN BY SUBCLASSES

        static get idField() {
            return "id";
        }

        static get collection() {
            throw new Error("collection must be overriden for model "+this);
        }

        static get endpoint() {
            throw new Error("endpoint must be overriden for model "+this);
        }

        static get name() {
            throw new Error("name must be overriden for model "+this);
        }

        static get handlers() {
            return {}
        }

        static get Schema() {
            return Joi.object();
        }

        static list(options) {
            log.debug("list %s", this.constructor.name);
            options = options || {};
            var coll = this.db.collection(this.collection);

            return _parseFilter(this, options).then(this.callStaticHandler('pre-list', options)).then((query) => {

                return coll.find(query).toArray().then((results) => {
                    if(options.wrap) {
                        return P.map(results, (r) => { return this.wrap(r)});
                    }
                    else {
                        return results;
                    }
                }).then(this.callStaticHandler('post-list', options));
            });

        }

        static show(id, options) {
            log.debug("show %s ", this.name, id);
            options = options || {};
            var _this = this;
            var coll = this.db.collection(this.collection);
            var q = {};

            if(_.isObject(id)) {
                q = id;
            }
            else {
                q[this.idField] = id;
            }

            return this.callStaticHandler('pre-show', options)(q).then(function(q) {
                return coll.findOne(q);
            }).then(function(data) {
                if(options.wrap) {
                    return _this.wrap(data);
                }
                else {
                    return data;
                }
            }).then(this.callStaticHandler('post-show', options));
        }

        static wrap(data) {
            if(!(data instanceof this)) {

                if(_.isArray(data)) {
                    var _this = this;
                    return _.map(data, function(d){ return new _this(d)});
                }
                else {

                    return new this(data);
                }
            }
            else
                return data;
        }

        /**
         * Helpful wrapper to create instances we know for sure doesn't exists
         * @returns {*}
         */
        create(options) {
            var _this = this;
            return this.callHandler('pre-create', options)(this).then(function() {
                return _this.save(null,{upsert: true});
            }).then(this.callHandler('post-create', options));
        }

        update(options) {
            var _this = this;
            return this.callHandler('pre-update', options)(this).then(function(data) {
                return _this.save(data);
            }).then(this.callHandler('post-update', options));
        }

        save(data, options) {
            data = data || this.toJSON();
            log.debug("Save", data[this.constructor.idField] || this[this.constructor.idField]);
            options = options || {upsert: false};
            var val = Joi.validate(data, this.constructor.Schema);
            if(val.error) {
                throw val.error;
            }
            else {
                var _this = this;

                var updateOp = {};

                var fieldsToRemove = _.pickBy(data, function (val) {
                    return _.isNull(val);
                });

                var fieldsToUpdate = _.omitBy(data, function (val, key) {
                    return key === _this.constructor.idField || _.isNull(val) || key === '_id';
                });

                if (_.keys(fieldsToUpdate).length > 0) {
                    updateOp.$set = fieldsToUpdate;
                }

                if (_.keys(fieldsToRemove).length > 0) {
                    updateOp.$unset = fieldsToRemove;
                }

                var q = {};
                q[this.constructor.idField] = this[this.constructor.idField];

                if(!this[this.constructor.idField]) {
                    q[this.constructor.idField] = this[this.constructor.idField] = random.id();
                }

                log.debug("Retrieving collection %s from db", this.constructor.collection, this.constructor.db);
                var coll = this.constructor.db.collection(this.constructor.collection);
                return coll.updateOne(q, updateOp, { upsert: options.upsert}).then(function() {
                    _.merge(_this, data);
                    return _this;
                });
            }
        }

        static callStaticHandler(key, options) {
            var _this = this;
            options = options || {};
            return P.method(function(result) {
                var service = _this.handlers[key];
                if(_.isFunction(service)) {
                    return service({
                        Model: _this,
                        data: result,
                        params: options.params,
                        credentials: options.credentials
                    });
                }
                else if(_.isObject(service)) {
                    service.Model = _this;
                    service.data = result;
                    service.credentials = options.credentials;
                    return server.cmbf.service(service);
                }
                else {
                    return result
                }
            });
        }

        callHandler(key, options) {
            var _this = this;
            options = options || {};
            return P.method(function(result) {
                var service = _this.constructor.handlers[key];
                if(_.isFunction(service)) {
                    return service({
                        model: _this,
                        Model: _this.constructor,
                        data: result,
                        params: options.params,
                        credentials: options.credentials
                    });
                }
                else if(_.isObject(service)) {
                    service.model = _this;
                    service.Model = _this.constructor;
                    service.data = result;
                    service.credentials = options.credentials;
                    return server.cmbf.service(service);
                }
                else {
                    return result
                }
            });
        }

        static remove(id, options) {
            log.debug("Remove", id);
            var coll = this.db.collection(this.collection);
            var q= {};
            q[this.idField] = id;
            return this.callStaticHandler('pre-remove', options)(q).then(function(check) {
                if(check) {
                    return coll.removeOne(q);
                }
            }).then(this.callStaticHandler('post-remove', options));
        }

        remove(options) {
            log.debug("Remove", this[this.constructor.idField]);
            var coll = this.constructor.db.collection(this.constructor.collection);
            var q= {};
            q[this.constructor.idField] = this[this.constructor.idField];
            return this.callHandler('pre-remove', options)(q).then(function(check) {
                if(check) {
                    return coll.removeOne(q);
                }
            }).then(this.callHandler('post-remove', options));
        }

        toJSON() {
            var val = Joi.validate(this, this.constructor.Schema);
            if(val.error) {
                throw val.error;
            }
            else {
                return _.omit(val.value);
            }
        };

        isUnique() {
            var coll = this.constructor.db.collection(this.constructor.collection);
            var q= {};
            q[this.constructor.idField] = this[this.constructor.idField];
            return coll.findOne(q).then(function(existing) {
                return !existing;
            });
        };

        static createValidateSpec(op) {

            if(this.validation[op]) {
                return this.validation[op];
            }
            else {
                var rules = {};
                if(this.schema) {
                    var schema = this.schema.describe();

                    // Create validation for query

                    // Create validation for params
                    
                    // Create validation for payload
                    // Add header validation

                }

                return rules;
            }

        };

    }

    return BaseModel;
};
