package Parser.GCode;

public record ToolInfo(Double toolRadius) {
    public ToolInfo() {
        this(0.0);
    }

    @Override
    public String toString() {
        return "ToolInfo[toolRadius=" + toolRadius() * 2 + "]";
    }
}
