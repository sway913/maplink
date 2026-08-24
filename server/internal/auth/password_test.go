package auth

import "testing"

func TestPasswordHashRoundTrip(t *testing.T) {
	encoded, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(encoded, "correct horse battery staple") {
		t.Fatal("expected password to verify")
	}
	if VerifyPassword(encoded, "wrong password") {
		t.Fatal("wrong password must not verify")
	}
}

func TestPasswordPolicy(t *testing.T) {
	if err := ValidatePassword("short"); err == nil {
		t.Fatal("expected short password to be rejected")
	}
	if err := ValidatePassword("this-is-long-enough"); err != nil {
		t.Fatalf("expected valid password, got %v", err)
	}
}
