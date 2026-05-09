//go:build darwin && cgo

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation -framework LocalAuthentication

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <dispatch/dispatch.h>
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

static void set_error(char *buffer, int buffer_len, NSString *message) {
	if (buffer == NULL || buffer_len <= 0) {
		return;
	}
	const char *text = message == nil ? "Touch ID failed" : [message UTF8String];
	snprintf(buffer, buffer_len, "%s", text);
}

static int confirm_with_biometrics(const char *reason, char *error_buffer, int error_buffer_len) {
	if (reason == NULL || strlen(reason) == 0) {
		set_error(error_buffer, error_buffer_len, @"text is required");
		return -3;
	}

	NSAutoreleasePool *pool = [[NSAutoreleasePool alloc] init];
	LAContext *context = [[LAContext alloc] init];
	NSError *policyError = nil;

	if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&policyError]) {
		set_error(error_buffer, error_buffer_len, policyError.localizedDescription);
		[context release];
		[pool drain];
		return -2;
	}

	dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
	NSString *localizedReason = [NSString stringWithUTF8String:reason];
	__block int result = 0;

	[context evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
		localizedReason:localizedReason
		reply:^(BOOL success, NSError *authError) {
			if (success) {
				result = 1;
			} else {
				set_error(error_buffer, error_buffer_len, authError.localizedDescription);
				result = 0;
			}
			dispatch_semaphore_signal(semaphore);
		}];

	dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
	[context release];
	[pool drain];
	return result;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

var errBiometricsUnavailable = errors.New("Touch ID is not available")

func requestBiometricConfirmation(reason string) (bool, error) {
	cReason := C.CString(reason)
	defer C.free(unsafe.Pointer(cReason))

	errBuf := make([]C.char, 512)
	result := C.confirm_with_biometrics(cReason, &errBuf[0], C.int(len(errBuf)))
	message := C.GoString(&errBuf[0])

	switch result {
	case 1:
		return true, nil
	case 0:
		if message == "" {
			message = "Touch ID was not confirmed"
		}
		return false, fmt.Errorf("%s", message)
	case -2:
		if message == "" {
			return false, errBiometricsUnavailable
		}
		return false, fmt.Errorf("%w: %s", errBiometricsUnavailable, message)
	default:
		if message == "" {
			message = "Touch ID request failed"
		}
		return false, errors.New(message)
	}
}
