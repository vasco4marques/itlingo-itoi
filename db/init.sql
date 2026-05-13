
CREATE PROCEDURE sp_createTables() 
language plpgsql
as $$
begin 

    CREATE TABLE t_workspaces
    (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        workspace varchar NOT NULL UNIQUE,
        CONSTRAINT t_workspaces_pkey PRIMARY KEY (id)
    );

    CREATE TABLE t_files (
        filename varchar not null,
        workspace_id uuid not null,
        create_date TIMESTAMP not null default now(),
        change_date TIMESTAMP,
        file bytea,
        PRIMARY KEY (filename, workspace_id),
        FOREIGN KEY (workspace_id) references t_workspaces(id)
    );

    CREATE TABLE t_workspaces_git (
        workspace_id uuid not null,
        giturl varchar, 
        PRIMARY KEY (workspace_id),
        FOREIGN KEY (workspace_id) references t_workspaces(id)
    );



end; $$;


CREATE PROCEDURE sp_dropTables() 
language plpgsql
as $$
begin 

    DROP TABLE t_workspaces;

    DROP TABLE t_files;

    DROP TABLE t_workspaces_git;

end; $$;



call sp_createTables();


--const selectQuery = "SELECT filename, file FROM t_files WHERE workspace=$1";


CREATE OR REPLACE FUNCTION fn_pullfiles(
	arg_workspace character varying)
    RETURNS TABLE(filename character varying, file bytea) 
    LANGUAGE 'plpgsql'

AS $$
DECLARE 
var_workspace_id uuid;
begin 

SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;

IF var_workspace_id IS NULL THEN
    INSERT INTO t_workspaces (workspace) VALUES (arg_workspace);
    SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;
END IF;
return QUERY SELECT t_files.filename, t_files.file FROM t_files WHERE workspace_id = var_workspace_id;

end; 
$$;

--INSERT INTO t_files (filename, workspace, file) VALUES ($1, $2, $3)

CREATE PROCEDURE sp_insertFiles(arg_filename varchar, arg_workspace varchar, arg_file bytea) 
language plpgsql
as $$
DECLARE 
var_workspace_id uuid;
begin 

SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;


INSERT INTO t_files (filename, workspace_id, file) VALUES (arg_filename, var_workspace_id, arg_file);

commit;

end; 
$$;



--const deleteQuery = "DELETE FROM t_files WHERE filename = $1 AND workspace = $2;"
--const insertQuery = "INSERT INTO t_files(filename, workspace, file) VALUES ($1, $2, $3)"

CREATE PROCEDURE sp_changeFile(arg_filename varchar, arg_workspace varchar, arg_file bytea) 
language plpgsql
as $$
DECLARE 
var_workspace_id uuid;
begin 


SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;


DELETE FROM t_files WHERE filename = arg_filename AND workspace_id = var_workspace_id;
INSERT INTO t_files (filename, workspace_id, file) VALUES (arg_filename, var_workspace_id, arg_file);


end; 
$$;



--deleteQuery = "DELETE FROM t_files WHERE filename LIKE $1 AND workspace = $2;"


CREATE PROCEDURE sp_deleteFile(arg_filename varchar, arg_workspace varchar) 
language plpgsql
as $$
DECLARE 
var_workspace_id uuid;
begin 


SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;


DELETE FROM t_files WHERE filename LIKE arg_filename AND workspace_id = var_workspace_id;

end; 
$$;


--const updateQuery = "UPDATE t_files SET filename=$1 WHERE filename=$2 AND workspace=$3";


CREATE PROCEDURE sp_updateFilename(old_filename varchar, new_filename varchar, arg_workspace varchar) 
language plpgsql
as $$
DECLARE 
var_workspace_id uuid;
begin 


SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;


UPDATE t_files SET filename=new_filename WHERE filename=old_filename AND workspace_id=var_workspace_id;

end; 
$$;



CREATE PROCEDURE sp_assignGit(arg_workspace varchar, arg_repo varchar) 
language plpgsql
as $$
DECLARE 
var_workspace_id uuid;
begin 


SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;


INSERT INTO t_workspaces_git (workspace_id, giturl) VALUES (var_workspace_id, arg_repo) 
    ON CONFLICT(workspace_id) DO UPDATE SET giturl = arg_repo;

end; 
$$;


CREATE PROCEDURE sp_removeGit(arg_workspace varchar) 
language plpgsql
as $$
DECLARE 
var_workspace_id uuid;
begin 


SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;


DELETE FROM t_workspaces_git WHERE workspace_id = var_workspace_id;

end; 
$$;




CREATE OR REPLACE FUNCTION fn_getGitRepo(
	arg_workspace character varying)
    RETURNS TABLE (repo varchar)
    LANGUAGE 'plpgsql'

AS $$
DECLARE 
var_workspace_id uuid;
begin 

SELECT t_workspaces.id into var_workspace_id FROM t_workspaces
	WHERE workspace = arg_workspace;

return query
    SELECT giturl FROM t_workspaces_git WHERE workspace_id = var_workspace_id;

end; 
$$;

