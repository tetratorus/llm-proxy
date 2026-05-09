//go:build !darwin || !cgo

package main

import "errors"

var errBiometricsUnavailable = errors.New("Touch ID is not available")

func requestBiometricConfirmation(reason string) (bool, error) {
	return false, errBiometricsUnavailable
}
