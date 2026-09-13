package Parser.GCode;

public class UnknownGCodeError extends Error {
    public UnknownGCodeError(String errorMessage) {
        super(errorMessage);
    }
}
