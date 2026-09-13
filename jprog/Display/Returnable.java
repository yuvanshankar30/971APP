package Display;

@FunctionalInterface
/**
 * Functional interface that allows objects to "return" to a previous known
 * working state
 */
public interface Returnable {
    /**
     * This function must return the object that threw the exception to a known
     * exception state(or to return to previous state)
     */
    public void returnTo();
}
