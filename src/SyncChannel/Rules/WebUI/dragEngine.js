define([], function () {
    'use strict';

    function sayHello() {
        console.log('dragEngine module loaded OK');
    }

    return {
        sayHello: sayHello
    };
});